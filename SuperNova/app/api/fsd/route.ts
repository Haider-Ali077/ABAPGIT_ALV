// Read-only access to stored FSD versions: one version's text, or two versions compared.
import { get, type FsdVersion } from "@/lib/db";
import { diffFsd } from "@/lib/fsd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const version = (id: string | null) => (id ? get<FsdVersion>("SELECT * FROM fsd_versions WHERE id = ?", Number(id)) : undefined);

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.has("from") || params.has("to")) {
    const from = version(params.get("from"));
    const to = version(params.get("to"));
    if (!from || !to) return new Response("Version not found", { status: 404 });
    if (from.requirement_id !== to.requirement_id) return new Response("Those versions belong to different requirements", { status: 400 });
    return Response.json({ from: { id: from.id, label: from.label }, to: { id: to.id, label: to.label }, diff: diffFsd(from.markdown, to.markdown) });
  }
  const one = version(params.get("id"));
  if (!one) return new Response("Version not found", { status: 404 });
  return Response.json({ id: one.id, label: one.label, status: one.status, markdown: one.markdown });
}
