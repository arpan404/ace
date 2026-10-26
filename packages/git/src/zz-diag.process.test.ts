import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { git, scratch } from "./test-repo.ts";

function probe(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TRACE: "1", GIT_TERMINAL_PROMPT: "0", ...env },
    });
    child.stdin.end();
    let out = "";
    child.stdout.on("data", (data: Buffer) => (out += data.toString()));
    child.stderr.on("data", (data: Buffer) => (out += data.toString()));
    const timer = setTimeout(() => {
      out += "\nTIMEOUT";
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      } catch {
        /* gone */
      }
    }, 12_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(`exit ${code}\n${out.slice(0, 4000)}`);
    });
  });
}

test.runIf(process.platform === "win32")("diag clone cwd forms", async () => {
  const base = await scratch();
  const source = join(base, "source");
  await mkdir(source);
  await git(source, "init", "--initial-branch=trunk");
  await writeFile(join(source, "a.txt"), "x\n");
  await git(source, "add", "a.txt");
  await git(source, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-m", "one");
  const url = `file:///${source.replaceAll("\\", "/")}`;
  const volume = execFileSync("mountvol", [`${base.slice(0, 2)}\\`, "/L"])
    .toString()
    .trim();
  const clone = [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.file.allow=always",
    "clone",
    "--progress",
    "--",
    url,
    ".",
  ];
  for (const [name, cwd] of [
    ["dos", join(base, "t1")],
    ["guid", `${volume}${join(base, "t2").slice(3)}`],
  ] as const) {
    await mkdir(name === "dos" ? cwd : join(base, "t2"));
    console.log(`=== ${name} ${cwd}\n${await probe(cwd, clone)}`);
  }
  await mkdir(join(base, "t3"));
  console.log(
    `=== guid status\n${await probe(`${volume}${join(base, "source").slice(3)}`, ["status"])}`,
  );
});
