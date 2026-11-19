import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { runTriageHandoff } from "./triage-launch.ts";

it.runIf(process.platform === "win32")(
  "on Windows, triage hands the terminal to an npm-style .cmd provider CLI in the triage folder",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-triage-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "npm bin");
    const folder = join(root, "triage folder");
    await mkdir(bin);
    await mkdir(folder);
    // What npm writes for a global CLI: a batch shim that runs node on the package's script.
    await writeFile(
      join(bin, "record.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "seen.json"))}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\nprocess.exit(7);\n`,
    );
    await writeFile(
      join(bin, "claude.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0record.cjs" %*\r\n`,
    );
    const prompt = `Read ${join(folder, "playbook.md")} and follow it; 100% "quoted" & (grouped).`;
    const code = await runTriageHandoff(
      "claude",
      prompt,
      {
        ...process.env,
        PATH: [bin, join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(";"),
      },
      folder,
    );
    expect(code).toBe(7);
    expect(JSON.parse(await readFile(join(root, "seen.json"), "utf8"))).toEqual({
      cwd: folder,
      args: ["--", prompt],
    });
  },
);
