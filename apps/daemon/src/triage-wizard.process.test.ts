import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalManager } from "@ace/terminal";
import { expect, it } from "vitest";
it("the terminal wizard previews the prompt then launches the selected CLI with literal text and its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-wizard-"));
  const home = join(root, "data");
  await mkdir(home, { mode: 0o700 });
  const capture = join(root, "received.json");
  const executable = join(root, "agent");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.exit(17);\n`,
  );
  await chmod(executable, 0o700);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ACE_HOME: home, PATH: root }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const manager = new TerminalManager();
  const child = manager.openTerminal({
    shell: process.execPath,
    args: [fileURLToPath(new URL("./cli.ts", import.meta.url)), "triage", "--provider", "cursor"],
    cwd: root,
    env,
    cols: 100,
    rows: 30,
    name: "Triage wizard",
  });
  let output = "";
  const replies = [
    { match: "Choose a prompt", text: "\u001b[B\r" },
    { match: "Describe what you need", text: "Keep 'quotes', $HOME and $(echo literal).\r\r" },
    { match: "Use this prompt", text: "\r" },
  ];
  const attachment = child.attach({ fromOffset: 0 });
  const outputTask = (async () => {
    for await (const event of attachment) {
      if (event.type !== "data") continue;
      output += event.data;
      const reply = replies[0];
      if (reply && output.includes(reply.match)) {
        replies.shift();
        child.write(reply.text);
      }
    }
  })();
  try {
    expect((await child.exited).code).toBe(17);
    await outputTask;
    const received = JSON.parse(await readFile(capture, "utf8"));
    expect(received[0]).toBe("--");
    expect(received).toHaveLength(2);
    expect(received[1]).toContain("acceptance criteria");
    expect(received[1]).not.toContain("ace doctor results");
    expect(received[1]).toContain("Keep 'quotes', $HOME and $(echo literal).");
    expect(output).toContain("# ace triage");
  } finally {
    attachment.detach();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("Ctrl-C leaves the template picker cleanly without generating or launching anything", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-wizard-cancel-"));
  const manager = new TerminalManager();
  const child = manager.openTerminal({
    shell: process.execPath,
    args: [fileURLToPath(new URL("./cli.ts", import.meta.url)), "triage"],
    cwd: home,
    env: { ...process.env, ACE_HOME: home, PATH: "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
    name: "Cancel triage",
  });
  let output = "";
  let cancelled = false;
  const attachment = child.attach({ fromOffset: 0 });
  const reading = (async () => {
    for await (const event of attachment) {
      if (event.type !== "data") continue;
      output += event.data;
      if (!cancelled && output.includes("Choose a prompt")) {
        cancelled = true;
        child.write("\u0003");
      }
    }
  })();
  try {
    expect((await child.exited).code).toBe(0);
    await reading;
    expect(output).toContain("Cancelled.");
    expect(output).not.toContain("Opening");
    expect(await readdir(home)).toEqual([]);
  } finally {
    attachment.detach();
    await manager.closeAll();
    await rm(home, { recursive: true, force: true });
  }
});
