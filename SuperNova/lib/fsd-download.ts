// FSD download. Every version stays available, so each file comes from that exact version's
// stored text and carries that version's real status on its cover and on every page.
import { CONSULTANT, all, audit, get, type FsdVersion, type Requirement } from "./db";
import { clientOf } from "./client";
import { buildFsdDocx } from "./docx";
import { buildFsdPdf } from "./pdf";

export type FsdFormat = "docx" | "pdf";
export type FsdFile = { filename: string; contentType: string; body: Uint8Array<ArrayBuffer> };
export type FsdDownload = { file: FsdFile } | { error: string; status: number };

export async function fsdDownload(id: number, format: FsdFormat): Promise<FsdDownload> {
  const fsd = get<FsdVersion>("SELECT * FROM fsd_versions WHERE id = ?", id);
  if (!fsd) return { error: "FSD not found", status: 404 };

  const r = get<Requirement>("SELECT * FROM requirements WHERE id = ?", fsd.requirement_id);
  const summary = r?.summary_json ? JSON.parse(r.summary_json) : {};
  const program: string = (fsd.wricef === "W" ? summary.workflow_name : summary.program_name) || `REQ-${fsd.requirement_id}`;
  const name = `${fsd.doc_type === "TS" ? "TS" : "FSD"}_${program.replace(/[^A-Za-z0-9_-]/g, "_")}_v${fsd.label}`;

  const input = {
    version: fsd,
    history: all<FsdVersion>("SELECT * FROM fsd_versions WHERE requirement_id = ? AND doc_type = ? AND version <= ? ORDER BY version", fsd.requirement_id, fsd.doc_type, fsd.version),
    project: r?.project ?? undefined,
    fsLabel: fsd.fs_version_id ? get<{ label: string }>("SELECT label FROM fsd_versions WHERE id = ?", fsd.fs_version_id)?.label : undefined,
    requirementId: fsd.requirement_id,
    requirementTitle: r?.title ?? "",
    client: clientOf(r?.client_id),
    approval: get<{ approver: string; decided_at: string }>("SELECT approver, decided_at FROM approvals WHERE fsd_version_id = ? ORDER BY id DESC LIMIT 1", fsd.id),
  };
  const file: FsdFile =
    format === "pdf"
      ? { filename: `${name}.pdf`, contentType: "application/pdf", body: new Uint8Array(await buildFsdPdf(input)) }
      : { filename: `${name}.docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: new Uint8Array(await buildFsdDocx(input)) };
  audit(CONSULTANT, "fsd.downloaded", fsd.requirement_id, { version: fsd.version, label: fsd.label, format });
  return { file };
}
