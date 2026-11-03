// Maps one FSD version onto the company's FSD layout: cover, requirement detail, numbered
// functional specification, sign-off. The DOCX and the PDF both draw from this, so they say the same thing.
import fs from "node:fs";
import path from "node:path";
import { marked, type Token, type Tokens } from "marked";
import type { FsdVersion } from "./db";
import { parseFsd, type FsdSection } from "./fsd";
import { parseFlow, type FlowStep } from "./flow-diagram";

export type FsdDocumentInput = {
  version: FsdVersion;
  history: FsdVersion[];
  requirementId: number;
  requirementTitle: string;
  /** The customer, asked for each requirement. Without one the document has no company name and no customer logo. */
  client?: { name: string; logo?: Uint8Array; logoType?: string };
  project?: string;
  /** For a TS: the FS version label it was written from. */
  fsLabel?: string;
  approval?: { approver: string; decided_at: string };
};

type FsdConfig = {
  functionalConsultant: string;
  technicalConsultant: string;
  signOff: { role: string; name: string }[];
};

export type LayoutSection = { title: string; intro?: string; fields?: string[][]; tokens: Token[]; flow?: FlowStep[] };

const SOLUTION_DESIGN = "Solution Design";
const OUTPUT_FIELDS_NOTE = "A brief description of form output fields";

export const templateFile = (name: string) => path.join(process.cwd(), "templates", name);
const config = () => JSON.parse(fs.readFileSync(templateFile("fsd-config.json"), "utf8")) as FsdConfig;

/** marked hands back &amp; and friends in text tokens; a document needs the characters. */
export const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const PAGE_POINTS = 451;
const CELL_MARGIN_POINTS = 12;
const LONGEST_KEPT_WORD = 22;

/**
 * Share of the page per column. Each column first gets room for its longest word, so a heading or
 * technical name is not broken in two, and what is left goes by content length: an ID column does
 * not need the same room as a description.
 */
export function columnShares(rows: string[][], pointsPerCharacter = 5): number[] {
  const count = rows[0].length;
  const cells = (c: number) => rows.map((r) => r[c] ?? "");
  const minimums = Array.from({ length: count }, (_, c) => {
    const word = Math.max(...cells(c).flatMap((t) => t.split(/\s+/).map((w) => w.length)));
    return (Math.min(word, LONGEST_KEPT_WORD) * pointsPerCharacter + CELL_MARGIN_POINTS) / PAGE_POINTS;
  });
  const weights = Array.from({ length: count }, (_, c) => {
    const lengths = cells(c).map((t) => t.length).sort((a, b) => b - a);
    return Math.min(Math.max(lengths[0], 6), 40) + lengths[Math.floor(lengths.length / 2)];
  });
  const needed = minimums.reduce((a, b) => a + b, 0);
  if (needed >= 1) return minimums.map((m) => m / needed);
  const total = weights.reduce((a, b) => a + b, 0);
  return minimums.map((m, c) => m + ((1 - needed) * weights[c]) / total);
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
};

const lex = (s: FsdSection) => marked.lexer(s.body);
const firstTable = (tokens: Token[]) => tokens.find((t) => t.type === "table") as Tokens.Table | undefined;
const cellText = (c?: Tokens.TableCell) => decodeEntities(c?.text ?? "").trim();

/** The document control table, whichever way round the model laid it out. */
function controlValues(section?: FsdSection) {
  const table = section && firstTable(lex(section));
  const values = new Map<string, string>();
  if (!table) return values;
  table.header.forEach((h, i) => values.set(cellText(h).toLowerCase(), cellText(table.rows[0]?.[i])));
  for (const row of table.rows) values.set(cellText(row[0]).toLowerCase(), cellText(row[1]));
  return values;
}


/** Output columns as the company's four-column field table. Unit and totals move into the logic text, so nothing is lost. */
function solutionDesign(section: FsdSection): LayoutSection {
  const tokens = lex(section);
  const table = firstTable(tokens);
  const headers = table?.header.map(cellText) ?? [];
  const find = (pattern: RegExp) => headers.findIndex((h) => pattern.test(h));
  const heading = find(/heading|label|field/i);
  const column = find(/technical|column/i);
  const source = find(/source|formula|logic/i);
  if (!table || heading < 0 || column < 0 || source < 0) return { title: SOLUTION_DESIGN, intro: OUTPUT_FIELDS_NOTE, tokens };

  const unit = find(/currency|unit/i);
  const totals = find(/total/i);
  const fields = table.rows.map((row) => {
    const from = cellText(row[source]);
    const tables = [...new Set([...from.matchAll(/\b([A-Z][A-Z0-9_]+)-[A-Z0-9_]+/g)].map((m) => m[1]))];
    const unitText = unit >= 0 ? cellText(row[unit]) : "";
    const totalText = totals >= 0 ? cellText(row[totals]) : "";
    const logic = [
      from,
      unitText && unitText !== "-" ? `Unit: ${unitText}` : "",
      totalText && !/^none$/i.test(totalText) ? `Totals: ${totalText}` : "",
    ].filter(Boolean);
    return [cellText(row[heading]), cellText(row[column]), tables.join(" / ") || "Calculated", logic.join(". ")];
  });
  return {
    title: SOLUTION_DESIGN,
    intro: OUTPUT_FIELDS_NOTE,
    fields: [["Field", "Technical Name", "Table", "Logic Description"], ...fields],
    tokens: tokens.filter((t) => t !== table),
  };
}

const STATUS_TEXT: Record<string, string> = { DRAFT: "Draft", APPROVED: "Approved", SUPERSEDED: "Superseded" };

export function buildFsdLayout({ version, history, requirementId, requirementTitle, client, project, fsLabel, approval }: FsdDocumentInput) {
  const company = config();
  const technical = version.doc_type === "TS";
  const workflow = version.wricef === "W";
  const { preamble, sections } = parseFsd(version.markdown);
  const h1 = preamble.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? requirementTitle;
  const program = h1.match(/\(([A-Z][A-Z0-9_]*)\)\s*$/)?.[1] ?? "";
  const title = h1.replace(/^(FSD|FS|TS)\s*[-:]\s*/i, "").replace(/\s*\([A-Z][A-Z0-9_]*\)\s*$/, "");

  const byKey = (key: string) => sections.find((s) => s.key === key);
  const control = controlValues(byKey("documentcontrol"));
  const purpose = sections.find((s) => s.key === "purpose" || s.key.startsWith("businessbackground") || s.key === "technicaloverview");
  // Only a report FS has the output columns that become the company field table.
  const output = technical || workflow ? undefined : byKey("outputcolumns");

  const transactions = sections
    .filter((s) => /interaction|authorization|flow/.test(s.key))
    .flatMap((s) => [...s.body.matchAll(/\b[A-Z]{2,3}\d{2}[A-Z]?\b/g)].map((m) => m[0]));

  const created = history[0]?.created_at ?? version.created_at;
  const first = (history[0]?.id ?? version.id) === version.id;
  const consultant = company.functionalConsultant || (control.get("author") ?? "");
  const author = technical ? company.technicalConsultant || (control.get("author") ?? "") : consultant;
  const cover: [string, string][] = [
    ["Company Name", client?.name ?? ""],
    ["Project", project ?? ""],
    ["Module", control.get("module") ?? ""],
    [workflow ? "Workflow ID" : "ABAP-ID", program || (control.get("program name") ?? control.get("workflow name") ?? "")],
    ["Requirement ID", `REQ-${requirementId}`],
    ["Requirement Title", title],
    ["WRICEF Type", workflow ? "Workflow (W)" : "Report (R)"],
    ["Priority", ""],
    ["Priority Type", ""],
    ["Deadline", ""],
    ["Functional Consultant Name (Requirements)*", consultant],
    ["Technical Consultant Name (Review and Detail) *", company.technicalConsultant],
    ["", ""],
    ["Date of Preparation", shortDate(created)],
    ["Approval Date", approval ? shortDate(approval.decided_at) : ""],
    ["Document Version", `${version.label} (${STATUS_TEXT[version.status] ?? version.status})`],
    ...(technical ? ([["Based on FS Version", fsLabel ?? ""]] as [string, string][]) : []),
  ];

  const skip = new Set(["documentcontrol", purpose?.key, output?.key]);
  const rest = sections.filter((s) => !skip.has(s.key)).map((s): LayoutSection => {
    const tokens = lex(s);
    return { title: s.title, tokens, flow: workflow && s.key === "processflow" ? parseFlow(tokens) : undefined };
  });
  const revisions = history.map((v) => [v.label, shortDate(v.created_at), STATUS_TEXT[v.status] ?? v.status, v.change_summary ?? ""]);

  return {
    title,
    program,
    technical,
    workflow,
    heading: technical ? "Technical Specification Document" : "Functional Specification Document",
    kind: technical ? "Technical Specification" : "Functional Specification",
    specifications: technical ? "Technical specifications" : "Functional specifications",
    revisions,
    documentTitle: `${title} - ${technical ? "TS" : "FS"} v${version.label}`,
    cover,
    purpose: purpose ? lex(purpose) : [],
    transactions: [...new Set(transactions)],
    sections: [...(output ? [solutionDesign(output)] : []), ...rest],
    client,
    signOff: company.signOff,
    footer: {
      createdBy: author,
      createdDate: shortDate(created),
      changedDate: first ? "MM/DD/YYYY" : shortDate(version.created_at),
      // The status has to show on every page, so a draft can never pass as signed off.
      version: `Ver ${version.label}${version.status === "APPROVED" ? "" : version.status === "DRAFT" ? " Draft" : " Superseded"}`,
    },
  };
}

export type FsdLayout = ReturnType<typeof buildFsdLayout>;
