// The pipeline: Chat -> FSD -> Approve -> Code (checks + repair passes) -> Export.
// Each step persists its result and writes the audit log.
import { createHash } from "node:crypto";
import {
  APPROVER, CONSULTANT, SYSTEM, all, audit, get, insert, now, setStatus, db,
  type CodeVersion, type FsdChange, type FsdVersion, type Requirement,
} from "./db";
import {
  applyFsdChangePlan, generateAbap, generateFsd, interviewTurn, planFsdChange, repairAbap, reviewCode,
  generateTs, type FsdChangePlan, type GeneratedProgram,
} from "./agents";
import { CHOICES, wricefLabel, type Wricef } from "./wricef";
import { applySectionChanges, changedSections, nextVersionLabel, renumberFsd } from "./fsd";
import { runChecks, type CheckReport } from "./checks";
import { exportProgram } from "./export";
import { ClientError, saveClient, type ClientInput } from "./client";
import type { ChatMessage } from "./llm";

export class StepError extends Error {}

const MAX_REPAIR_PASSES = 3;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function requirement(id: number): Requirement {
  const r = get<Requirement>("SELECT * FROM requirements WHERE id = ?", id);
  if (!r) throw new StepError(`Requirement ${id} not found.`);
  return r;
}

export type DocType = "FS" | "TS";

export function latestDoc(id: number, docType: DocType) {
  return get<FsdVersion>("SELECT * FROM fsd_versions WHERE requirement_id = ? AND doc_type = ? ORDER BY version DESC LIMIT 1", id, docType);
}

export function latestFsd(id: number) {
  return latestDoc(id, "FS");
}

export function latestTs(id: number) {
  return latestDoc(id, "TS");
}

const docName = (t: string) => (t === "TS" ? "TS" : "FS");
const supportedType = (r: Requirement) => {
  if (r.wricef !== "R" && r.wricef !== "W") throw new StepError("Only Report and Workflow requirements are supported.");
  return r.wricef as Wricef;
};

export function latestCode(id: number) {
  return get<CodeVersion>("SELECT * FROM code_versions WHERE requirement_id = ? ORDER BY version DESC LIMIT 1", id);
}

export function programOf(c: CodeVersion): GeneratedProgram {
  return { program_name: c.program_name, title: c.title, abap_source: c.abap_source, selection_texts: JSON.parse(c.selection_texts_json) };
}

// ----------------------------------------------------------------- 1. Chat
/** Creates the requirement; the caller then runs interviewStep (so an LLM failure still leaves a retryable requirement). */
export type StartOptions = { choice?: string; project?: string };

/**
 * Creates the requirement for a supported classification. Unsupported WRICEF types are refused here
 * as well as on the page, so nothing is ever created for them.
 */
export function createRequirement(text: string, client: ClientInput = {}, options: StartOptions = {}): number {
  const choice = CHOICES.find((c) => c.id === (options.choice ?? "report"));
  if (!choice) throw new StepError("Choose what kind of solution this is first.");
  if (!choice.supported || !choice.wricef) throw new StepError(choice.message ?? "This kind of solution is not supported.");
  const t = text.trim();
  if (t.length < 15) throw new StepError("Please describe the requirement in at least one sentence.");
  const clientId = withClient(() => saveClient(client));
  const title = t.length > 80 ? `${t.slice(0, 77)}...` : t;
  const id = insert(
    "INSERT INTO requirements (title, requirement_text, status, client_id, wricef, execution_mode, project, created_by, created_at, updated_at) VALUES (?, ?, 'INTERVIEW', ?, ?, ?, ?, ?, ?, ?)",
    title, t, clientId, choice.wricef, choice.wricef === "R" ? (choice.execution ?? "ONLINE") : null, options.project?.trim() || null, CONSULTANT, now(), now(),
  );
  audit(CONSULTANT, "requirement.created", id, { text: t, client: client.name?.trim(), wricef: choice.wricef, execution: choice.execution });
  return id;
}

/** One business need with a report part and an approval part: two requirements that point at each other. */
export function createLinkedPair(text: string, client: ClientInput = {}, project?: string) {
  const report = createRequirement(text, client, { choice: "report", project });
  const workflow = createRequirement(text, client, { choice: "workflow", project });
  const link = db().prepare("UPDATE requirements SET linked_requirement_id = ? WHERE id = ?");
  link.run(workflow, report);
  link.run(report, workflow);
  audit(CONSULTANT, "requirement.linked", report, { report, workflow });
  return { report, workflow };
}

function interviewContext(r: Requirement) {
  const lines: string[] = [];
  if (r.wricef === "R") lines.push(`Execution: ${r.execution_mode === "BACKGROUND" ? "runs as a background job" : "run online by the user"}.`);
  if (r.linked_requirement_id) {
    lines.push(
      r.wricef === "R"
        ? `This is only the report part. The approval part is a separate linked Workflow requirement (REQ-${r.linked_requirement_id}); do not ask about approvals.`
        : `This is only the workflow part. The reporting part is a separate linked Report requirement (REQ-${r.linked_requirement_id}); do not ask about report output.`,
    );
  }
  return lines.join("\n");
}

/** Every completed interview becomes a numbered requirement revision; the earlier ones are kept. */
function addRevision(r: Requirement, summary: unknown, reason: string) {
  const last = get<{ revision: number }>("SELECT revision FROM requirement_revisions WHERE requirement_id = ? ORDER BY revision DESC LIMIT 1", r.id);
  const revision = (last?.revision ?? 0) + 1;
  insert(
    "INSERT INTO requirement_revisions (requirement_id, revision, wricef, summary_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    r.id, revision, r.wricef, JSON.stringify(summary), reason, now(),
  );
  return revision;
}

/** Corrects an earlier interview answer. Only before the FS exists; after that the change goes through Modify FS. */
export async function reviseAnswer(id: number, text: string) {
  const r = requirement(id);
  const said = text.trim();
  if (!said) throw new StepError("Write the corrected answer.");
  if (!["INTERVIEW", "SUMMARY_READY"].includes(r.status) || latestFsd(id)) {
    throw new StepError("The FS has been written already. Use Modify FS to change it.");
  }
  if (r.status === "SUMMARY_READY") setStatus(id, "INTERVIEW");
  audit(CONSULTANT, "interview.answer_revised", id, { text: said });
  await interviewStep(id, `Correction to an earlier answer: ${said}`, false, "Answers revised");
}

/**
 * Changes Report to Workflow or back. The interview restarts for the new type and documents written for
 * the old type stop being current; they stay in the history, and no approval record is touched.
 */
export async function changeWricef(id: number, wricef: string, confirmed: boolean) {
  const r = requirement(id);
  if (wricef !== "R" && wricef !== "W") throw new StepError("Only Report and Workflow are supported.");
  if (wricef === r.wricef) return;
  if (!confirmed) throw new StepError("Confirm the change of solution type first.");
  const from = wricefLabel(r.wricef);
  const to = wricefLabel(wricef);
  db().prepare("UPDATE fsd_versions SET status = 'SUPERSEDED' WHERE requirement_id = ? AND status IN ('DRAFT', 'APPROVED')").run(id);
  db()
    .prepare("UPDATE requirements SET wricef = ?, execution_mode = ?, status = 'INTERVIEW', questions_asked = 0, updated_at = ? WHERE id = ?")
    .run(wricef, wricef === "R" ? "ONLINE" : null, now(), id);
  audit(CONSULTANT, "requirement.type_changed", id, { from: r.wricef, to: wricef, documents_superseded: true });
  await interviewStep(id, `The solution type changed from ${from} to ${to}. Re-check the requirement as a ${to}: ask what a ${to} needs that is not known yet.`, false, `Type changed to ${to}`);
}

/** Sets or changes the customer a requirement's FSD is written for. Applies to every version's download. */
export function setRequirementClient(id: number, client: ClientInput) {
  requirement(id);
  const clientId = withClient(() => saveClient(client));
  db().prepare("UPDATE requirements SET client_id = ?, updated_at = ? WHERE id = ?").run(clientId, now(), id);
  audit(CONSULTANT, "requirement.client_set", id, { client: client.name?.trim(), logo: !!client.logo });
}

function withClient<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw e instanceof ClientError ? new StepError(e.message) : e;
  }
}

/**
 * Adds the consultant's answer (if any) and lets the interviewer respond. With finish, the interview ends now.
 * The answer is saved before the LLM call, so a failed call can be retried without typing it again.
 */
export async function interviewStep(id: number, answer?: string, finish = false, reason = "Interview completed") {
  const r = requirement(id);
  const wricef = supportedType(r);
  if (r.status !== "INTERVIEW") throw new StepError("The interview for this requirement is already complete.");
  if (answer?.trim()) {
    insert("INSERT INTO messages (requirement_id, role, content, created_at) VALUES (?, 'user', ?, ?)", id, answer.trim(), now());
  }
  const transcript = all<ChatMessage>("SELECT role, content FROM messages WHERE requirement_id = ? ORDER BY id", id);
  if (transcript.length && transcript[transcript.length - 1].role === "assistant") {
    throw new StepError("Waiting for your answer.");
  }

  const turn = await interviewTurn(r.requirement_text, transcript, r.questions_asked, finish, wricef, interviewContext(r));
  const tracking = { coverage: turn.coverage ?? [], contradictions: turn.contradictions ?? [] };
  db().prepare("UPDATE requirements SET interview_state_json = ? WHERE id = ?").run(JSON.stringify(tracking), id);
  const content =
    turn.status === "questions"
      ? [turn.message, ...turn.questions].join("\n")
      : turn.message;
  insert("INSERT INTO messages (requirement_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)", id, content, now());

  if (turn.status === "questions") {
    db().prepare("UPDATE requirements SET questions_asked = questions_asked + ?, updated_at = ? WHERE id = ?").run(turn.questions.length, now(), id);
    audit(SYSTEM, "interview.questions", id, { count: turn.questions.length });
  } else {
    const summary = turn.summary as Record<string, unknown>;
    db()
      .prepare("UPDATE requirements SET summary_json = ?, title = COALESCE(?, title), status = 'SUMMARY_READY', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(summary), typeof summary.title === "string" ? summary.title : null, now(), id);
    const revision = addRevision(requirement(id), summary, reason);
    audit(SYSTEM, "interview.completed", id, { name: summary.program_name ?? summary.workflow_name, revision });
  }
}

// ------------------------------------------------------------------ 2. FSD
type VersionChange = { type: "MINOR" | "MAJOR"; summary: string; parent: FsdVersion };

/**
 * Only ever inserts: an existing version's text is never changed, only its status moves on to SUPERSEDED.
 * FS and TS number their versions separately. A new FS makes the current TS stale, because a TS is
 * always written from one FS version.
 */
function addFsdVersion(
  id: number, markdown: string, source: "AGENT" | "EDIT" | "MODIFY", author: string, change?: VersionChange, docType: DocType = "FS", fsVersionId: number | null = null,
) {
  const r = requirement(id);
  const prev = latestDoc(id, docType);
  const version = (prev?.version ?? 0) + 1;
  const label = change ? nextVersionLabel(prev?.label, change.type) : "1.0";
  const sections = change ? JSON.stringify(changedSections(change.parent.markdown, markdown)) : null;
  if (prev?.status === "APPROVED") audit(author, `${docType.toLowerCase()}.approval_voided`, id, { approved_version: prev.label, reason: `new ${docType} version` });
  db().prepare("UPDATE fsd_versions SET status = 'SUPERSEDED' WHERE requirement_id = ? AND doc_type = ? AND status IN ('DRAFT', 'APPROVED')").run(id, docType);
  if (docType === "FS") {
    const ts = latestTs(id);
    if (ts && ts.status !== "SUPERSEDED") {
      db().prepare("UPDATE fsd_versions SET status = 'SUPERSEDED' WHERE id = ?").run(ts.id);
      audit(author, "ts.superseded", id, { ts: ts.label, reason: "the FS changed" });
    }
  }
  const fsdId = insert(
    `INSERT INTO fsd_versions (requirement_id, version, markdown, sha256, status, source, author, created_at, label, parent_id, change_type, change_summary, sections_changed_json, doc_type, wricef, fs_version_id)
     VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, version, markdown, sha256(markdown), source, author, now(), label, change?.parent.id ?? null, change?.type ?? "INITIAL",
    change?.summary ?? `Initial ${docType}`, sections, docType, r.wricef, fsVersionId,
  );
  setStatus(id, docType === "FS" ? "FSD_DRAFT" : "TS_DRAFT");
  return { fsdId, version, label };
}

export async function generateFsdStep(id: number) {
  const r = requirement(id);
  if (!r.summary_json) throw new StepError("Finish the requirement interview first.");
  const wricef = supportedType(r);
  const markdown = renumberFsd(await generateFsd(JSON.parse(r.summary_json), r.requirement_text, wricef));
  const prev = latestFsd(id);
  const change = prev ? { type: "MAJOR" as const, summary: "Regenerated from the requirement summary", parent: prev } : undefined;
  const v = addFsdVersion(id, markdown, "AGENT", "FSD Generator Agent", change);
  audit(SYSTEM, "fsd.generated", id, { version: v.version, label: v.label });
}

/** Writes the TS from the approved FS. Regenerating makes a new major TS version; earlier ones stay. */
export async function generateTsStep(id: number) {
  const r = requirement(id);
  const wricef = supportedType(r);
  const fs = latestFsd(id);
  if (!fs || fs.status !== "APPROVED") throw new StepError("Approve the FS before writing the TS.");
  const markdown = renumberFsd(await generateTs(fs.markdown, JSON.parse(r.summary_json ?? "{}"), wricef, fs.label));
  const prev = latestTs(id);
  const change = prev ? { type: "MAJOR" as const, summary: `Regenerated from FS v${fs.label}`, parent: prev } : undefined;
  const v = addFsdVersion(id, markdown, "AGENT", "TS Generator Agent", change, "TS", fs.id);
  if (!prev) db().prepare("UPDATE fsd_versions SET change_summary = ? WHERE id = ?").run(`Initial TS, from FS v${fs.label}`, v.fsdId);
  audit(SYSTEM, "ts.generated", id, { version: v.version, label: v.label, fs: fs.label });
}

export function saveFsdEdit(id: number, markdown: string, summary?: string, docType: DocType = "FS") {
  const prev = latestDoc(id, docType);
  if (!prev) throw new StepError(`Generate the ${docType} first.`);
  const text = markdown.replace(/\r\n/g, "\n");
  if (text === prev.markdown) return;
  const v = addFsdVersion(id, text, "EDIT", CONSULTANT, { type: "MINOR", summary: summary?.trim() || "Manual edit", parent: prev }, docType, prev.fs_version_id);
  audit(CONSULTANT, `${docType.toLowerCase()}.edited`, id, { version: v.version, label: v.label });
}

// ---------------------------------------------------------------- Modify FSD
function fsdVersion(id: number, versionId: number) {
  const f = get<FsdVersion>("SELECT * FROM fsd_versions WHERE id = ? AND requirement_id = ?", versionId, id);
  if (!f) throw new StepError("That document version does not exist.");
  return f;
}

function openChange(id: number, changeId: number) {
  const c = get<FsdChange>("SELECT * FROM fsd_changes WHERE id = ? AND requirement_id = ?", changeId, id);
  if (!c) throw new StepError("That change request does not exist.");
  if (c.status !== "OPEN") throw new StepError("That change request is already closed.");
  return c;
}

export function currentChange(id: number, docType: DocType = "FS") {
  return get<FsdChange>(
    `SELECT c.* FROM fsd_changes c JOIN fsd_versions f ON f.id = c.base_version_id
     WHERE c.requirement_id = ? AND c.status = 'OPEN' AND f.doc_type = ? ORDER BY c.id DESC LIMIT 1`,
    id, docType,
  );
}

/**
 * Starts or refines a change and asks the AI what it would do. Nothing in the FSD changes here.
 * The request is saved first: if the LLM call fails the conversation survives, and calling again without text retries it.
 */
export async function proposeFsdChange(id: number, text?: string, baseVersionId?: number, changeId?: number, docType: DocType = "FS") {
  const said = text?.trim();
  let change: FsdChange;
  if (changeId) {
    change = openChange(id, changeId);
  } else {
    if (!said) throw new StepError("Describe the change you want.");
    const base = baseVersionId ? fsdVersion(id, baseVersionId) : latestDoc(id, docType);
    if (!base) throw new StepError(`Generate the ${docType} first.`);
    const open = currentChange(id, base.doc_type as DocType);
    if (open) discardFsdChange(id, open.id);
    const t = now();
    const newId = insert(
      "INSERT INTO fsd_changes (requirement_id, base_version_id, conversation_json, status, created_at, updated_at) VALUES (?, ?, '[]', 'OPEN', ?, ?)",
      id, base.id, t, t,
    );
    change = openChange(id, newId);
  }

  const conversation = JSON.parse(change.conversation_json) as ChatMessage[];
  if (said) conversation.push({ role: "user", content: said });
  if (conversation[conversation.length - 1]?.role !== "user") throw new StepError("Add what you would like to refine.");
  const save = db().prepare("UPDATE fsd_changes SET conversation_json = ?, proposal_json = ?, updated_at = ? WHERE id = ?");
  save.run(JSON.stringify(conversation), change.proposal_json, now(), change.id);

  const baseDoc = fsdVersion(id, change.base_version_id);
  const plan = await planFsdChange(baseDoc.markdown, conversation, baseDoc.doc_type);
  conversation.push({ role: "assistant", content: `${plan.understood} ${plan.explanation}` });
  save.run(JSON.stringify(conversation), JSON.stringify(plan), now(), change.id);
  audit(CONSULTANT, "fsd.change_proposed", id, { change: change.id, request: said ?? "(retry)", type: plan.change_type });
}

/** Generates the new version from a confirmed proposal. The base version stays as it is. */
export async function applyFsdChange(id: number, changeId: number, type?: "MINOR" | "MAJOR") {
  const change = openChange(id, changeId);
  if (!change.proposal_json) throw new StepError("There is no proposal to confirm yet.");
  const plan = JSON.parse(change.proposal_json) as FsdChangePlan;
  const base = fsdVersion(id, change.base_version_id);
  const conversation = JSON.parse(change.conversation_json) as ChatMessage[];

  const result = await applyFsdChangePlan(base.markdown, conversation, plan, base.doc_type);
  // Merged by code, not by the model: a section it did not return cannot change.
  const markdown = applySectionChanges(base.markdown, result.sections);
  if (markdown.trim() === base.markdown.trim()) throw new StepError("The AI returned no actual change. Refine the request and try again.");

  const changeType = type ?? (plan.change_type === "major" ? "MAJOR" : "MINOR");
  const v = addFsdVersion(id, markdown, "MODIFY", "Modify Agent", { type: changeType, summary: result.summary, parent: base }, base.doc_type as DocType, base.fs_version_id);
  db().prepare("UPDATE fsd_changes SET status = 'APPLIED', result_version_id = ?, updated_at = ? WHERE id = ?").run(v.fsdId, now(), change.id);
  audit(CONSULTANT, "fsd.modified", id, { from: base.label, to: v.label, type: changeType, summary: result.summary });
}

export function discardFsdChange(id: number, changeId: number) {
  const change = openChange(id, changeId);
  db().prepare("UPDATE fsd_changes SET status = 'DISCARDED', updated_at = ? WHERE id = ?").run(now(), change.id);
  audit(CONSULTANT, "fsd.change_discarded", id, { change: change.id });
}

// ------------------------------------------------- comments and open questions
export function addFsdComment(id: number, versionId: number, section: string, text: string) {
  const t = text.trim();
  if (!t) throw new StepError("Write a comment first.");
  insert(
    "INSERT INTO fsd_annotations (requirement_id, fsd_version_id, kind, section, text, author, created_at) VALUES (?, ?, 'COMMENT', ?, ?, ?, ?)",
    id, fsdVersion(id, versionId).id, section, t, CONSULTANT, now(),
  );
  audit(CONSULTANT, "fsd.commented", id, { section });
}

/** Resolved questions belong to the requirement, not one version, so a new version keeps them resolved. */
export function setQuestionResolved(id: number, versionId: number, question: string, resolved: boolean) {
  db().prepare("DELETE FROM fsd_annotations WHERE requirement_id = ? AND kind = 'RESOLVED' AND section = ?").run(id, question);
  if (resolved) {
    insert(
      "INSERT INTO fsd_annotations (requirement_id, fsd_version_id, kind, section, text, author, created_at) VALUES (?, ?, 'RESOLVED', ?, '', ?, ?)",
      id, fsdVersion(id, versionId).id, question, CONSULTANT, now(),
    );
  }
  audit(CONSULTANT, resolved ? "fsd.question_resolved" : "fsd.question_reopened", id, { question });
}

// -------------------------------------------------------------- 3. Approve
export function approveFsd(id: number, fsdVersionId: number) {
  const target = get<FsdVersion>("SELECT * FROM fsd_versions WHERE id = ? AND requirement_id = ?", fsdVersionId, id);
  const docType = (target?.doc_type ?? "FS") as DocType;
  const fsd = latestDoc(id, docType);
  if (!fsd || fsd.id !== fsdVersionId) throw new StepError(`Only the latest ${docType} version can be approved. Reload the page.`);
  if (fsd.status !== "DRAFT") throw new StepError(`${docType} v${fsd.label} is ${fsd.status}, not DRAFT.`);
  if (docType === "TS") {
    const fs = latestFsd(id);
    if (!fs || fs.status !== "APPROVED" || fs.id !== fsd.fs_version_id) {
      throw new StepError("This TS was written from an FS version that is no longer the approved one. Regenerate the TS.");
    }
  }
  const decidedAt = now();
  insert(
    "INSERT INTO approvals (requirement_id, fsd_version_id, approver, decision, sha256, decided_at) VALUES (?, ?, ?, 'APPROVED', ?, ?)",
    id, fsd.id, APPROVER, fsd.sha256, decidedAt,
  );
  db().prepare("UPDATE fsd_versions SET status = 'APPROVED' WHERE id = ?").run(fsd.id);
  setStatus(id, docType === "FS" ? "FSD_APPROVED" : "TS_APPROVED");
  audit(APPROVER, `${docType.toLowerCase()}.approved`, id, { version: fsd.version, label: fsd.label, sha256: fsd.sha256, decided_at: decidedAt });
}

// ----------------------------------------------------------------- 4. Code
function saveCode(id: number, fsdId: number, kind: "GENERATED" | "REPAIRED", p: GeneratedProgram, checks: CheckReport) {
  const version = (latestCode(id)?.version ?? 0) + 1;
  insert(
    `INSERT INTO code_versions (requirement_id, fsd_version_id, version, kind, program_name, title, abap_source, selection_texts_json, checks_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, fsdId, version, kind, p.program_name, p.title, p.abap_source, JSON.stringify(p.selection_texts), JSON.stringify(checks), now(),
  );
  return version;
}

/** Report types the Dev agent can build: it writes CL_SALV ALV reports only. */
const GENERATED_REPORT_TYPES = ["ALV", "OO ALV", "Interactive ALV"];

export function codeGenerationBlocker(r: Requirement): string | null {
  if (r.wricef === "W") {
    return "SuperNova does not generate workflow objects. The FS and TS are the workflow deliverables: a technical design to build in SWDD or the Manage Workflows app.";
  }
  const type = r.summary_json ? (JSON.parse(r.summary_json).report_type as string | undefined) : undefined;
  if (type && !GENERATED_REPORT_TYPES.includes(type)) {
    return `The code generator builds ALV reports only. This report is "${type}", so the TS is the deliverable and the program is written by hand.`;
  }
  return null;
}

export async function generateCodeStep(id: number) {
  const r = requirement(id);
  const blocker = codeGenerationBlocker(r);
  if (blocker) throw new StepError(blocker);
  const fsd = latestFsd(id);
  if (!fsd || fsd.status !== "APPROVED") throw new StepError("The latest FSD must be approved before ABAP is generated.");
  const ts = latestTs(id);
  if (!ts || ts.status !== "APPROVED" || ts.fs_version_id !== fsd.id) {
    throw new StepError("Generate and approve the TS for the current FS first. The code follows the approved TS.");
  }

  const first = await generateAbap(fsd.markdown, ts.markdown);
  const firstChecks = runChecks(first);
  const v1 = saveCode(id, fsd.id, "GENERATED", first, firstChecks);
  audit(SYSTEM, "code.generated", id, { version: v1, program: first.program_name, errors: firstChecks.errors, warnings: firstChecks.warnings });

  // Repair from the best version so far, and stop as soon as a pass stops helping.
  let best = { program: first, checks: firstChecks };
  let last = best;
  for (let pass = 1; pass <= MAX_REPAIR_PASSES && best.checks.errors > 0; pass++) {
    const errors = best.checks.issues.filter((i) => i.severity === "error");
    const repaired = await repairAbap(fsd.markdown, best.program, errors);
    const repairedChecks = runChecks(repaired);
    const v = saveCode(id, fsd.id, "REPAIRED", repaired, repairedChecks);
    audit(SYSTEM, "code.repaired", id, { version: v, pass, errors_before: best.checks.errors, errors_after: repairedChecks.errors });
    last = { program: repaired, checks: repairedChecks };
    if (repairedChecks.errors >= best.checks.errors) break;
    best = last;
  }
  // The latest version is the one that gets exported, so it must not be a repair that made things worse.
  if (last !== best) {
    const v = saveCode(id, fsd.id, "REPAIRED", best.program, best.checks);
    audit(SYSTEM, "code.repair_reverted", id, { version: v, errors: best.checks.errors, errors_discarded: last.checks.errors });
  }
  setStatus(id, "CODE_READY");
}

export async function reviewStep(id: number) {
  const fsd = latestFsd(id);
  const code = latestCode(id);
  if (!fsd || !code) throw new StepError("Generate the ABAP code first.");
  const checks = JSON.parse(code.checks_json) as CheckReport;
  const review = await reviewCode(fsd.markdown, code.abap_source, checks.issues);
  db().prepare("UPDATE code_versions SET review_json = ? WHERE id = ?").run(JSON.stringify(review), code.id);
  audit(SYSTEM, "code.reviewed", id, { version: code.version, findings: review.findings.length });
}

// --------------------------------------------------------------- 5. Export
export async function exportStep(id: number, force: boolean) {
  const r = requirement(id);
  if (r.wricef !== "R") throw new StepError("Only reports produce an abapGit export.");
  const code = latestCode(id);
  const fsd = latestFsd(id);
  if (!code || !fsd) throw new StepError("Generate the ABAP code first.");
  if (fsd.status !== "APPROVED" || code.fsd_version_id !== fsd.id) {
    throw new StepError("The code was generated from an FSD version that is no longer the approved one. Regenerate the code.");
  }
  const checks = runChecks(programOf(code));
  if (checks.errors > 0 && !force) throw new StepError(`The code still has ${checks.errors} check error(s). Tick "export anyway" to export it regardless.`);

  const approval = get<{ approver: string; decided_at: string }>(
    "SELECT approver, decided_at FROM approvals WHERE fsd_version_id = ? ORDER BY id DESC LIMIT 1", fsd.id,
  );
  const message = [
    `${code.program_name}: export from REQ-${id} (code v${code.version})`,
    "",
    `Requirement: ${r.title}`,
    `FSD v${fsd.label} approved by ${approval?.approver} at ${approval?.decided_at} (sha256 ${fsd.sha256.slice(0, 12)})`,
    `Rule-based checks: ${checks.errors} error(s), ${checks.warnings} warning(s)${checks.errors && force ? " - exported anyway" : ""}`,
    "",
    "Generated by SuperNova. NOT activated in a real SAP system.",
  ].join("\n");

  const result = await exportProgram(programOf(code), fsd.markdown, message);
  insert(
    "INSERT INTO exports (requirement_id, code_version_id, folder, zip_path, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id, code.id, result.folder, result.zipPath, result.commitSha, now(),
  );
  setStatus(id, "EXPORTED");
  audit(CONSULTANT, "code.exported", id, {
    version: code.version, folder: result.folder, zip: result.zipPath, commit: result.commitSha, note: result.commitNote, forced: checks.errors > 0,
  });
  return result;
}
