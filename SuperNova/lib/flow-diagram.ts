// Draws a workflow's process flow from the FS "Process flow" table (Step, Type, Actor, Description, Next).
// The table is the source: the diagram follows every edit and version of the document, and nothing
// is drawn that the table does not say.
import type { Token, Tokens } from "marked";

export type FlowStep = { step: number; type: string; actor: string; description: string; next: { label: string; to: number }[] };
export type FlowDiagram = { svg: string; width: number; height: number; warnings: string[] };

const clean = (s?: string) => (s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

/** Reads the first table that has Step, Type and Next columns. */
export function parseFlow(tokens: Token[]): FlowStep[] {
  for (const t of tokens) {
    if (t.type !== "table") continue;
    const table = t as Tokens.Table;
    const head = table.header.map((h) => clean(h.text).toLowerCase());
    const col = (name: string) => head.findIndex((h) => h.startsWith(name));
    const [step, type, actor, description, next] = ["step", "type", "actor", "description", "next"].map(col);
    if (step < 0 || type < 0 || next < 0) continue;
    return table.rows
      .map((row) => ({
        step: Number(clean(row[step]?.text).match(/\d+/)?.[0] ?? NaN),
        type: clean(row[type]?.text),
        actor: actor >= 0 ? clean(row[actor]?.text) : "",
        description: description >= 0 ? clean(row[description]?.text) : "",
        next: [...clean(row[next]?.text).matchAll(/(?:([^:;,]+?)\s*:\s*)?(?:step\s*)?(\d+)/gi)].map((m) => ({ label: (m[1] ?? "").trim(), to: Number(m[2]) })),
      }))
      .filter((s) => Number.isFinite(s.step));
  }
  return [];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line + " " + word).trim().length > width && line) {
      out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = out[lines - 1].replace(/.{0,3}$/, "...");
  }
  return out;
}

const STYLE: Record<string, { fill: string; stroke: string }> = {
  start: { fill: "#E2F0D9", stroke: "#548235" },
  end: { fill: "#E2F0D9", stroke: "#548235" },
  task: { fill: "#DEEAF6", stroke: "#2F5496" },
  approval: { fill: "#FFF2CC", stroke: "#BF9000" },
  decision: { fill: "#FCE4D6", stroke: "#C55A11" },
  notification: { fill: "#EDE7F6", stroke: "#5B4B8A" },
  system: { fill: "#EDEDED", stroke: "#595959" },
};

const WIDTH = 660;
const BOX_X = 110;
const BOX_W = 300;
const CX = BOX_X + BOX_W / 2;
const GAP = 38;

export function drawFlow(steps: FlowStep[]): FlowDiagram | null {
  if (steps.length < 2) return null;
  const warnings: string[] = [];
  const kind = (s: FlowStep) => {
    const k = s.type.toLowerCase().split(/\s/)[0];
    return STYLE[k] ? k : "task";
  };
  const height = (s: FlowStep) => (kind(s) === "decision" ? 78 : kind(s) === "start" || kind(s) === "end" ? 44 : 62);

  // Stack the steps top to bottom in their numbered order.
  const pos = new Map<number, { y: number; h: number }>();
  let y = 20;
  for (const s of steps) {
    pos.set(s.step, { y, h: height(s) });
    y += height(s) + GAP;
  }
  const total = y - GAP + 20;
  const parts: string[] = [];
  const marker = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#44546A"/></marker></defs>';

  // Edges first, so the shapes sit on top of the lines.
  type Jump = { from: FlowStep; to: number; label: string; forward: boolean; lane: number };
  const jumps: Jump[] = [];
  steps.forEach((s, i) => {
    const from = pos.get(s.step)!;
    for (const edge of s.next) {
      const to = pos.get(edge.to);
      if (!to) {
        warnings.push(`Step ${s.step} points to step ${edge.to}, which does not exist.`);
        continue;
      }
      if (steps[i + 1]?.step === edge.to) {
        const y1 = from.y + from.h;
        parts.push(`<line x1="${CX}" y1="${y1}" x2="${CX}" y2="${to.y - 2}" stroke="#44546A" stroke-width="1.6" marker-end="url(#arrow)"/>`);
        if (edge.label) parts.push(`<text x="${CX + 8}" y="${y1 + 16}" font-size="11" fill="#44546A" font-family="Arial">${esc(edge.label)}</text>`);
      } else {
        jumps.push({ from: s, to: edge.to, label: edge.label, forward: edge.to > s.step, lane: 0 });
      }
    }
    if (!s.next.length && kind(s) !== "end") warnings.push(`Step ${s.step} has no next step.`);
  });

  // Shorter jumps take the inner lanes, so a jump never crosses the lines of one it sits inside.
  const span = (j: Jump) => [Math.min(j.from.step, j.to), Math.max(j.from.step, j.to)];
  for (const side of [true, false]) {
    const placed: Jump[] = [];
    for (const j of jumps.filter((x) => x.forward === side).sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]))) {
      const [a, b] = span(j);
      const taken = new Set(placed.filter((p) => span(p)[0] <= b && a <= span(p)[1]).map((p) => p.lane));
      while (taken.has(j.lane)) j.lane++;
      placed.push(j);
    }
  }
  // A diamond's side slopes, so its edge depends on the height the line leaves at.
  const edgeOf = (s: FlowStep, side: "left" | "right", y: number) => {
    const { y: top, h } = pos.get(s.step)!;
    const half = kind(s) === "decision" ? ((BOX_W - 40) / 2) * (1 - Math.abs(y - (top + h / 2)) / (h / 2)) : BOX_W / 2;
    return side === "right" ? CX + half : CX - half;
  };
  // Several jumps on one side of a box leave (or arrive) at different heights, so lines and labels never share a spot.
  const port = (step: number, forward: boolean, end: "out" | "in", j: Jump) => {
    const { y: top, h } = pos.get(step)!;
    const group = jumps.filter((x) => x.forward === forward && (end === "out" ? x.from.step === step : x.to === step));
    if (group.length < 2 || kind(steps.find((s) => s.step === step)!) === "decision") return top + h / 2;
    return top + (h * (group.indexOf(j) + 1)) / (group.length + 1);
  };
  for (const j of jumps) {
    const target = steps.find((s) => s.step === j.to)!;
    const y1 = port(j.from.step, j.forward, "out", j);
    const y2 = port(j.to, j.forward, "in", j);
    if (j.forward) {
      const lane = BOX_X + BOX_W + 30 + Math.min(j.lane, 9) * 22;
      const x1 = edgeOf(j.from, "right", y1);
      parts.push(`<path d="M${x1},${y1} H${lane} V${y2} H${edgeOf(target, "right", y2) + 2}" fill="none" stroke="#44546A" stroke-width="1.6" marker-end="url(#arrow)"/>`);
      if (j.label) parts.push(`<text x="${x1 + 6}" y="${y1 - 5}" font-size="10.5" fill="#44546A" font-family="Arial">${esc(j.label)}</text>`);
    } else {
      const lane = BOX_X - 26 - Math.min(j.lane, 3) * 18;
      const x1 = edgeOf(j.from, "left", y1);
      parts.push(`<path d="M${x1},${y1} H${lane} V${y2} H${edgeOf(target, "left", y2) - 2}" fill="none" stroke="#44546A" stroke-width="1.6" stroke-dasharray="5 3" marker-end="url(#arrow)"/>`);
      if (j.label) parts.push(`<text x="${x1 - 6}" y="${y1 - 5}" font-size="11" text-anchor="end" fill="#44546A" font-family="Arial">${esc(j.label)}</text>`);
    }
  }

  for (const s of steps) {
    const { y: top, h } = pos.get(s.step)!;
    const k = kind(s);
    const { fill, stroke } = STYLE[k];
    const heading = `${s.step}. ${s.actor || s.type}`;
    if (k === "decision") {
      const w = BOX_W - 40;
      parts.push(`<polygon points="${CX},${top} ${CX + w / 2},${top + h / 2} ${CX},${top + h} ${CX - w / 2},${top + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`);
      const lines = wrap(s.description || s.type, 30, 2);
      parts.push(`<text x="${CX}" y="${top + h / 2 - (lines.length - 1) * 7 + 4}" font-size="11.5" text-anchor="middle" font-family="Arial" fill="#1F2937">${lines.map((l, i) => `<tspan x="${CX}" dy="${i ? 14 : 0}">${esc(l)}</tspan>`).join("")}</text>`);
    } else {
      const rx = k === "start" || k === "end" ? h / 2 : 6;
      const width = k === "approval" ? 2.6 : 1.6;
      parts.push(`<rect x="${BOX_X}" y="${top}" width="${BOX_W}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>`);
      const lines = k === "start" || k === "end" ? [] : wrap(s.description, 46, 2);
      if (k === "start" || k === "end") {
        const pill = wrap(`${s.type}${s.description ? `: ${s.description}` : ""}`, 44, 2);
        pill.forEach((l, i) => parts.push(`<text x="${CX}" y="${top + h / 2 + 4 - (pill.length - 1) * 7.5 + i * 15}" font-size="12.5" font-weight="bold" text-anchor="middle" font-family="Arial" fill="#1F2937">${esc(l)}</text>`));
        continue;
      }
      const first = top + (lines.length ? 20 : h / 2 + 4);
      parts.push(`<text x="${CX}" y="${first}" font-size="12.5" font-weight="bold" text-anchor="middle" font-family="Arial" fill="#1F2937">${esc(heading)}</text>`);
      lines.forEach((l, i) => parts.push(`<text x="${CX}" y="${first + 17 + i * 15}" font-size="11.5" text-anchor="middle" font-family="Arial" fill="#374151">${esc(l)}</text>`));
    }
  }

  const legend = ["Task", "Approval", "Decision", "Notification", "System"]
    .map((name, i) => {
      const { fill, stroke } = STYLE[name.toLowerCase()];
      const x = 20 + i * 126;
      return `<rect x="${x}" y="${total + 6}" width="14" height="14" rx="3" fill="${fill}" stroke="${stroke}"/><text x="${x + 20}" y="${total + 17}" font-size="11" font-family="Arial" fill="#44546A">${name}</text>`;
    })
    .join("");
  const fullHeight = total + 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${fullHeight}" viewBox="0 0 ${WIDTH} ${fullHeight}"><rect width="100%" height="100%" fill="#FFFFFF"/>${marker}${parts.join("")}${legend}</svg>`;
  return { svg, width: WIDTH, height: fullHeight, warnings };
}

/** PNG for Word and the PDF; sharp is already installed with Next. */
export async function flowPng(diagram: FlowDiagram): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(diagram.svg), { density: 192 }).png().toBuffer();
}
