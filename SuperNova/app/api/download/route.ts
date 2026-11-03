import fs from "node:fs";
import path from "node:path";
import { get } from "@/lib/db";
import { fsdDownload } from "@/lib/fsd-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const fsdId = params.get("fsd");
  if (fsdId) {
    const result = await fsdDownload(Number(fsdId), params.get("format") === "pdf" ? "pdf" : "docx");
    if ("error" in result) return new Response(result.error, { status: result.status });
    const { filename, contentType, body } = result.file;
    return new Response(body, { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"` } });
  }

  const exportId = Number(params.get("export"));
  const row = get<{ zip_path: string }>("SELECT zip_path FROM exports WHERE id = ?", exportId);
  if (!row || !fs.existsSync(row.zip_path)) return new Response("Export not found", { status: 404 });
  return new Response(fs.readFileSync(row.zip_path), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${path.basename(row.zip_path)}"`,
    },
  });
}
