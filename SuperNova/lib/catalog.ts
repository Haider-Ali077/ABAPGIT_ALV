import fs from "node:fs";
import path from "node:path";

export type CatalogField = { type: string; text: string; key?: boolean; values?: Record<string, string>; ref?: string };
export type Catalog = {
  tables: Record<string, { description: string; fields: Record<string, CatalogField> }>;
  authorization_objects: Record<string, { text: string; fields: string[] }>;
  drilldowns: Record<string, { transaction: string; text: string }>;
};

let cached: Catalog | undefined;

export function catalog(): Catalog {
  if (!cached) {
    const file = path.join(process.cwd(), "catalog", "sap-catalog.json");
    cached = JSON.parse(fs.readFileSync(file, "utf8")) as Catalog;
  }
  return cached;
}

/** Compact text form of the catalog for prompts. */
export function catalogForPrompt(): string {
  const c = catalog();
  const lines: string[] = [];
  for (const [name, t] of Object.entries(c.tables)) {
    lines.push(`### ${name} - ${t.description}`);
    for (const [field, f] of Object.entries(t.fields)) {
      const values = f.values
        ? ` [${Object.entries(f.values)
            .map(([k, v]) => `'${k}'=${v}`)
            .join(", ")}]`
        : "";
      lines.push(`- ${field}${f.key ? " (key)" : ""}: ${f.type}, ${f.text}${values}`);
    }
    lines.push("");
  }
  lines.push("### Authorization objects");
  for (const [name, o] of Object.entries(c.authorization_objects)) lines.push(`- ${name}: ${o.text} (fields ${o.fields.join(", ")})`);
  lines.push("", "### Drill-down transactions (parameter ID -> transaction)");
  for (const [pid, d] of Object.entries(c.drilldowns)) lines.push(`- ${pid} -> ${d.transaction}: ${d.text}`);
  return lines.join("\n");
}
