import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function tempRepo(): Promise<{ root: string; parent: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agent-team-test-"));
  const root = path.join(parent, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["config", "user.name", "Agent Team Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(path.join(root, ".gitignore"), ".env\nnode_modules/\n");
  await writeFile(path.join(root, "note.txt"), "hello world\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
  return { root, parent };
}
