// A saved customer logo, for the page to show next to the company name.
import { get } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  const row = get<{ logo: Uint8Array | null; logo_type: string | null }>("SELECT logo, logo_type FROM clients WHERE id = ?", id);
  if (!row?.logo || !row.logo_type) return new Response("No logo", { status: 404 });
  return new Response(Uint8Array.from(row.logo), { headers: { "Content-Type": row.logo_type, "Cache-Control": "no-cache" } });
}
