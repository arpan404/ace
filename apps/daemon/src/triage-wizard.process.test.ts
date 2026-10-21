import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
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
    { match: "Choose a prompt", text: "1\r" },
    { match: "End with a line", text: "Keep 'quotes', $HOME and $(echo literal).\r.\r" },
    { match: "Use this prompt", text: "1\r" },
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
    expect(received[1]).toContain("Keep 'quotes', $HOME and $(echo literal).");
    expect(output).toContain("# ace triage");
  } finally {
    attachment.detach();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
