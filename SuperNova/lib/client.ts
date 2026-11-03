// The customer an FSD is written for: its name and logo. SuperNova's own logo is fixed in the template;
// the customer's is asked for each requirement, never assumed.
import { get, now, db, type Client } from "./db";

export type ClientInput = { name?: string; logo?: string; logoType?: string };
export type LogoSize = { width: number; height: number };

const MAX_LOGO_BYTES = 1_000_000;

export class ClientError extends Error {}

/** The real type comes from the file's first bytes, not from what the browser says it is. */
function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export function imageSize(bytes: Uint8Array, type: string): LogoSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") return bytes.length > 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const length = view.getUint16(i + 2);
    // Start-of-frame markers carry the size; C4, C8 and CC share the range but are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

/** Largest size that fits the box and keeps the logo's proportions. */
export function fitInto(size: LogoSize | null, box: LogoSize): LogoSize {
  if (!size || !size.width || !size.height) return box;
  const scale = Math.min(box.width / size.width, box.height / size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

function decodeLogo(base64: string) {
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  if (bytes.length > MAX_LOGO_BYTES) throw new ClientError("The logo must be smaller than 1 MB.");
  const type = sniff(bytes);
  if (!type) throw new ClientError("The logo must be a PNG or JPG image.");
  return { bytes, type };
}

/** Finds the client by name or creates it. A new logo replaces the saved one; without one the saved logo stays. */
export function saveClient(input: ClientInput): number {
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2) throw new ClientError("Enter the client company name.");
  if (name.length > 120) throw new ClientError("The company name is too long.");
  const logo = input.logo ? decodeLogo(input.logo) : null;
  const existing = get<Client>("SELECT * FROM clients WHERE name = ?", name);
  if (existing) {
    if (logo) db().prepare("UPDATE clients SET logo = ?, logo_type = ?, name = ?, updated_at = ? WHERE id = ?").run(logo.bytes, logo.type, name, now(), existing.id);
    return existing.id;
  }
  const t = now();
  const added = db().prepare("INSERT INTO clients (name, logo, logo_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(name, logo?.bytes ?? null, logo?.type ?? null, t, t);
  return Number(added.lastInsertRowid);
}

export function clientOf(clientId: number | null | undefined) {
  if (!clientId) return undefined;
  const c = get<Client>("SELECT * FROM clients WHERE id = ?", clientId);
  if (!c) return undefined;
  return { name: c.name, logo: c.logo ? Uint8Array.from(c.logo) : undefined, logoType: c.logo_type ?? undefined };
}
