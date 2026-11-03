// Export: write the abapGit repo to a local folder, commit it to a local git
// repository (never pushed) and build a ZIP for abapGit "New Offline" -> "Import ZIP".
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { serializeProgram, type RepoFile } from "./abapgit";
import type { GeneratedProgram } from "./agents";

export type ExportResult = { folder: string; zipPath: string; commitSha: string | null; commitNote: string; files: RepoFile[] };

export async function exportProgram(p: GeneratedProgram, fsdMarkdown: string, commitMessage: string): Promise<ExportResult> {
  const files = serializeProgram(p, [{ path: "docs/FSD.md", content: fsdMarkdown }]);
  const root = path.join(process.cwd(), "output");
  const folder = path.join(root, "repos", p.program_name.toLowerCase());
  fs.mkdirSync(folder, { recursive: true });

  // Replace the previous export completely (keep the git history).
  for (const entry of fs.readdirSync(folder)) {
    if (entry !== ".git") fs.rmSync(path.join(folder, entry), { recursive: true, force: true });
  }
  for (const f of files) {
    const target = path.join(folder, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, "utf8");
  }

  const { sha, note } = commitLocally(folder, commitMessage);

  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const zipPath = path.join(root, "zips", `${p.program_name.toLowerCase()}_${stamp}.zip`);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, buffer);

  return { folder, zipPath, commitSha: sha, commitNote: note, files };
}

function commitLocally(folder: string, message: string): { sha: string | null; note: string } {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, "-c", "core.autocrlf=false", "-c", "user.name=SuperNova", "-c", "user.email=supernova@localhost", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    if (!fs.existsSync(path.join(folder, ".git"))) git("init", "-q");
    git("add", "-A");
    if (git("status", "--porcelain") === "") {
      return { sha: git("rev-parse", "HEAD"), note: "No changes since the last export; nothing new to commit." };
    }
    git("commit", "-q", "-m", message);
    return { sha: git("rev-parse", "HEAD"), note: "Committed to the local repository (not pushed)." };
  } catch (e) {
    return { sha: null, note: `Local git commit failed: ${(e as Error).message.split("\n")[0]}` };
  }
}
