import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES: Record<string, string> = {
  "README.md":
    "# calc-demo\n\nA tiny arithmetic library used to exercise coding agents. It exports `add` and `multiply` from `src/math.ts` and string helpers from `src/strings.ts`.\n",
  "src/math.ts":
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n",
  "src/strings.ts":
    "export function shout(text: string): string {\n  return `${text.toUpperCase()}!`;\n}\n",
  "notes/todo.md": "- add subtraction\n- add validation\n",
};

/** Create a throwaway git repository with only synthetic content. */
export function createWorkspace(label: string): string {
  // realpath: macOS tmpdir is a symlink, and providers report resolved paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ace-rec-${label}-`)));
  for (const [path, content] of Object.entries(FILES)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.name=ace-recorder",
    "-c",
    "user.email=recorder@ace.invalid",
    "commit",
    "-q",
    "-m",
    "init",
  );
  return root;
}
