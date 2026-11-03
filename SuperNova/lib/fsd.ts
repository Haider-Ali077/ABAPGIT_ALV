// FSD document logic with no I/O, so the page and the server share it: sections,
// merging an AI change, version numbers and comparing two versions.

export type FsdSection = { heading: string; title: string; key: string; raw: string; body: string };
export type ParsedFsd = { preamble: string; sections: FsdSection[] };
export type SectionChange = { heading: string; action: "replace" | "add" | "remove"; markdown: string };

export const sectionTitle = (heading: string) => heading.replace(/^\s*\d+[.)]?\s*/, "").trim();
export const sectionKey = (heading: string) => sectionTitle(heading).toLowerCase().replace(/[^a-z0-9]+/g, "");

function toSection(lines: string[]): FsdSection {
  const heading = lines[0].replace(/^##\s+/, "").trim();
  return { heading, title: sectionTitle(heading), key: sectionKey(heading), raw: lines.join("\n"), body: lines.slice(1).join("\n").trim() };
}

/** Splits on "## " headings. joinFsd( parseFsd( x ) ) === x, so a section nobody touched stays byte-identical. */
export function parseFsd(markdown: string): ParsedFsd {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const parts: string[][] = [[]];
  let fenced = false;
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && /^##\s+\S/.test(line)) parts.push([]);
    parts[parts.length - 1].push(line);
  }
  return { preamble: parts[0].join("\n"), sections: parts.slice(1).map(toSection) };
}

export function joinFsd({ preamble, sections }: ParsedFsd): string {
  return [...(preamble ? [preamble] : []), ...sections.map((s) => s.raw)].join("\n");
}

const numbered = (s: FsdSection) => /^\d+[.)]?\s/.test(s.heading);

function renumber(sections: FsdSection[]): FsdSection[] {
  if (!sections.some(numbered)) return sections;
  return sections.map((s, i) => {
    const heading = `${i + 1}. ${s.title}`;
    return heading === s.heading ? s : toSection([`## ${heading}`, ...s.raw.split("\n").slice(1)]);
  });
}

/** Numbers the "## " headings in order; nothing else in the text changes. */
export function renumberFsd(markdown: string): string {
  const doc = parseFsd(markdown);
  return joinFsd({ ...doc, sections: renumber(doc.sections) });
}

/** Applies only the listed changes. Every other section is left exactly as it was. */
export function applySectionChanges(markdown: string, changes: SectionChange[]): string {
  const doc = parseFsd(markdown);
  let sections = [...doc.sections];
  const closing = () => {
    const i = sections.findIndex((s) => /assumption|openquestion/.test(s.key));
    return i < 0 ? sections.length : i;
  };
  for (const c of changes) {
    const key = sectionKey(c.heading.replace(/^##\s+/, ""));
    const at = sections.findIndex((s) => s.key === key);
    if (c.action === "remove") {
      if (at >= 0) sections.splice(at, 1);
      continue;
    }
    const text = c.markdown.trim();
    const lines = (/^##\s+\S/.test(text) ? text : `## ${c.heading.replace(/^##\s+/, "")}\n\n${text}`).split("\n");
    const section = toSection([...lines, ""]);
    if (at >= 0) sections[at] = section;
    else sections.splice(closing(), 0, section);
  }
  sections = renumber(sections);
  // The last section in a file has no separating blank line after it.
  return joinFsd({ preamble: doc.preamble, sections }).replace(/\n*$/, "\n");
}

export function nextVersionLabel(latest: string | undefined, type: "MINOR" | "MAJOR"): string {
  if (!latest) return "1.0";
  const [major, minor] = latest.split(".").map(Number);
  return type === "MAJOR" ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

// ------------------------------------------------------------------- compare
export type DiffLine = { op: "same" | "add" | "del"; text: string };
export type SectionDiff = { title: string; key: string; status: "added" | "removed" | "modified" | "unchanged"; area: string; lines: DiffLine[] };
export type RequirementDiff = { id: string; before?: string; after?: string };
export type FsdDiff = {
  sections: SectionDiff[];
  requirements: { added: RequirementDiff[]; modified: RequirementDiff[]; removed: RequirementDiff[] };
};

/** The units a reader thinks in: one table row, list item or paragraph. */
function blocks(body: string): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(para.join(" "));
    para = [];
  };
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) flush();
    else if (t.startsWith("|")) {
      flush();
      if (!/^\|[\s:|-]+\|?$/.test(t)) out.push(t.replace(/\s*\|\s*/g, " | ").trim());
    } else if (/^([-*+]|\d+\.)\s/.test(t) || t.startsWith("#")) {
      flush();
      out.push(t);
    } else para.push(t);
  }
  flush();
  return out;
}

export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  return out;
}

function areaOf(key: string) {
  if (/scope/.test(key)) return "Scope";
  if (/businessrule|functionalrequirement/.test(key)) return "Business rules";
  if (/flow|workflow|interaction|process/.test(key)) return "Workflow";
  return "Other";
}

const REQUIREMENT_ID = /\b(FR-\d+)\b/;

function requirementsOf(sections: FsdSection[]) {
  const found = new Map<string, string>();
  for (const s of sections) {
    for (const b of blocks(s.body)) {
      const id = b.slice(0, 24).match(REQUIREMENT_ID)?.[1];
      if (id && !found.has(id)) found.set(id, b);
    }
  }
  return found;
}

export function diffFsd(fromMarkdown: string, toMarkdown: string): FsdDiff {
  const from = parseFsd(fromMarkdown).sections;
  const to = parseFsd(toMarkdown).sections;
  const fromByKey = new Map(from.map((s) => [s.key, s]));
  const toKeys = new Set(to.map((s) => s.key));

  const sections: SectionDiff[] = to.map((s) => {
    const before = fromByKey.get(s.key);
    const lines = diffLines(before ? blocks(before.body) : [], blocks(s.body));
    const status = !before ? "added" : lines.some((l) => l.op !== "same") ? "modified" : "unchanged";
    return { title: s.title, key: s.key, status, area: areaOf(s.key), lines };
  });
  for (const s of from) {
    if (!toKeys.has(s.key)) {
      sections.push({ title: s.title, key: s.key, status: "removed", area: areaOf(s.key), lines: blocks(s.body).map((text) => ({ op: "del", text })) });
    }
  }

  const a = requirementsOf(from);
  const b = requirementsOf(to);
  const requirements: FsdDiff["requirements"] = { added: [], modified: [], removed: [] };
  for (const [id, after] of b) {
    const before = a.get(id);
    if (before === undefined) requirements.added.push({ id, after });
    else if (before !== after) requirements.modified.push({ id, before, after });
  }
  for (const [id, before] of a) if (!b.has(id)) requirements.removed.push({ id, before });
  return { sections, requirements };
}

/** Sections that differ, in the form stored on a version and shown in its history. */
export function changedSections(fromMarkdown: string, toMarkdown: string) {
  return diffFsd(fromMarkdown, toMarkdown).sections.filter((s) => s.status !== "unchanged").map((s) => ({ title: s.title, status: s.status }));
}

/** Questions from the "Open questions" section, without the table header and without placeholder rows. */
export function openQuestions(markdown: string): string[] {
  const section = parseFsd(markdown).sections.find((s) => s.key === "openquestions");
  if (!section) return [];
  return section.body
    .split("\n")
    .map((l) => l.trim())
    .flatMap((l) => {
      if (l.startsWith("|")) {
        const cells = l.split("|").slice(1, -1).map((c) => c.trim());
        if (/^[:\s-]+$/.test(cells.join("")) || /^id$/i.test(cells[0] ?? "")) return [];
        return /^Q-\d+$/i.test(cells[0] ?? "") ? [cells[1] ?? ""] : [cells[0] ?? ""];
      }
      const item = l.match(/^(?:[-*+]|\d+\.)\s+(.*)$/)?.[1];
      return item ? [item] : [];
    })
    .filter((q) => q && !/^(none|n\/a|no open questions)\.?$/i.test(q));
}
