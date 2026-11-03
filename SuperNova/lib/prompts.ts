import fs from "node:fs";
import path from "node:path";

/** Loads prompts/<name>.md and fills {{placeholders}}. Read on every call so prompts can be tuned without a restart. */
export function loadPrompt(name: string, vars: Record<string, string | number> = {}): string {
  const text = fs.readFileSync(path.join(process.cwd(), "prompts", `${name}.md`), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt ${name}: missing value for {{${key}}}`);
    return String(vars[key]);
  });
}
