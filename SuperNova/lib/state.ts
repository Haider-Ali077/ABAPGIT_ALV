// Everything the single page needs, in one read.
import { all, get, type CodeVersion, type FsdAnnotation, type FsdVersion, type Requirement } from "./db";
import { llmPublicInfo } from "./llm";
import { serializeProgram } from "./abapgit";
import { codeGenerationBlocker, currentChange, programOf } from "./pipeline";
import { runChecks } from "./checks";
import { MAX_QUESTIONS } from "./agents";

export function pageState(id: number | null) {
  const requirements = all<{ id: number; title: string; status: string; wricef: string }>("SELECT id, title, status, wricef FROM requirements ORDER BY id DESC LIMIT 20");
  const clients = all<{ id: number; name: string; has_logo: number; updated_at: string }>(
    "SELECT id, name, logo IS NOT NULL AS has_logo, updated_at FROM clients ORDER BY name",
  ).map((c) => ({ id: c.id, name: c.name, hasLogo: !!c.has_logo, updatedAt: c.updated_at }));
  const base = { llm: llmPublicInfo(), maxQuestions: MAX_QUESTIONS, requirements, clients };
  const r = id ? get<Requirement>("SELECT * FROM requirements WHERE id = ?", id) : undefined;
  if (!r) return { ...base, requirement: null };

  const versionsOf = (docType: string) => all<FsdVersion>("SELECT * FROM fsd_versions WHERE requirement_id = ? AND doc_type = ? ORDER BY version DESC", r.id, docType);
  const fsdVersions = versionsOf("FS");
  const tsVersions = versionsOf("TS");
  const latest = fsdVersions[0];
  const codes = all<CodeVersion>("SELECT * FROM code_versions WHERE requirement_id = ? ORDER BY version DESC", r.id);
  // Show the code generated from the latest FSD version: the last two passes.
  const current = latest ? codes.filter((c) => c.fsd_version_id === latest.id).slice(0, 2).reverse() : [];
  const change = currentChange(r.id, "FS");
  const tsChange = currentChange(r.id, "TS");
  const listed = (versions: FsdVersion[]) =>
    versions.map(({ markdown, ...v }) => ({
      ...v,
      parent_label: versions.find((p) => p.id === v.parent_id)?.label ?? null,
      fs_label: fsdVersions.find((f) => f.id === v.fs_version_id)?.label ?? null,
      sections_changed: v.sections_changed_json ? JSON.parse(v.sections_changed_json) : null,
    }));
  const openChange = (c: ReturnType<typeof currentChange>) =>
    c ? { ...c, conversation: JSON.parse(c.conversation_json), proposal: c.proposal_json ? JSON.parse(c.proposal_json) : null } : null;
  const linked = r.linked_requirement_id ? get<{ id: number; title: string; wricef: string; status: string }>("SELECT id, title, wricef, status FROM requirements WHERE id = ?", r.linked_requirement_id) : undefined;

  return {
    ...base,
    requirement: {
      ...r,
      summary: r.summary_json ? JSON.parse(r.summary_json) : null,
      client: clients.find((c) => c.id === r.client_id) ?? null,
      interview: r.interview_state_json ? JSON.parse(r.interview_state_json) : { coverage: [], contradictions: [] },
      linked: linked ?? null,
      codeBlocker: codeGenerationBlocker(r),
    },
    revisions: all("SELECT revision, wricef, reason, created_at FROM requirement_revisions WHERE requirement_id = ? ORDER BY revision DESC", r.id),
    messages: all("SELECT role, content, created_at FROM messages WHERE requirement_id = ? ORDER BY id", r.id),
    fsd: latest ?? null,
    fsdVersions: listed(fsdVersions),
    fsdChange: openChange(change),
    ts: tsVersions[0] ?? null,
    tsVersions: listed(tsVersions),
    tsChange: openChange(tsChange),
    annotations: all<FsdAnnotation>("SELECT * FROM fsd_annotations WHERE requirement_id = ? ORDER BY id", r.id),
    approvals: all(
      "SELECT a.*, f.version, f.label, f.doc_type FROM approvals a JOIN fsd_versions f ON f.id = a.fsd_version_id WHERE a.requirement_id = ? ORDER BY a.id DESC",
      r.id,
    ),
    code: current.map((c) => ({
      id: c.id,
      version: c.version,
      kind: c.kind,
      program_name: c.program_name,
      title: c.title,
      abap_source: c.abap_source,
      selection_texts: JSON.parse(c.selection_texts_json),
      // Run live, not from checks_json: a score saved before a rule existed must not pass as clean.
      checks: runChecks(programOf(c)),
      review: c.review_json ? JSON.parse(c.review_json) : null,
      files: serializeProgram(programOf(c)).filter((f) => f.path.endsWith(".xml")),
      created_at: c.created_at,
    })),
    exports: all("SELECT * FROM exports WHERE requirement_id = ? ORDER BY id DESC", r.id),
    audit: all("SELECT ts, actor, action, details_json FROM audit_log WHERE requirement_id = ? ORDER BY id DESC LIMIT 40", r.id),
  };
}
