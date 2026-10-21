import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalManager } from "@ace/terminal";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
type Reply = { match: string; text: string };

/** Drive `ace triage` in a real PTY, answering each screen as it appears. */
async function drive(input: { args: string[]; stubs: Record<string, string>; replies: Reply[] }) {
  const root = await mkdtemp(join(tmpdir(), "ace-wizard-"));
  const home = join(root, "data");
  await mkdir(home, { mode: 0o700 });
  for (const [name, body] of Object.entries(input.stubs)) {
    await writeFile(join(root, name), `#!${process.execPath}\n${body}\n`);
    await chmod(join(root, name), 0o700);
  }
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ACE_HOME: home, PATH: root }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const manager = new TerminalManager();
  const child = manager.openTerminal({
    shell: process.execPath,
    args: [cli, "triage", ...input.args],
    cwd: root,
    env,
    cols: 100,
    rows: 40,
    name: "Triage wizard",
  });
  let output = "";
  const replies = [...input.replies];
  const attachment = child.attach({ fromOffset: 0 });
  const reading = (async () => {
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
    const { code } = await child.exited;
    await reading;
    return { code, output, root };
  } finally {
    attachment.detach();
    await manager.closeAll();
  }
}
/** A stand-in agent CLI that records the arguments of its real (non --version) launch. */
const recorder = (capture: string, exit: number) =>
  `import {writeFileSync} from 'node:fs'; if (process.argv[2] !== '--version') writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.exit(${exit});`;

it("the wizard asks template questions, previews the prompt and launches Cursor with literal text and its exit code", async () => {
  const capture = join(tmpdir(), `ace-wizard-cursor-${process.pid}.json`);
  const run = await drive({
    args: ["--provider", "cursor"],
    stubs: { agent: recorder(capture, 17) },
    replies: [
      { match: "What do you need?", text: "\u001b[B\r" },
      { match: "What should ace do?", text: "Keep 'quotes', $HOME and $(echo literal).\r\r" },
      { match: "How will you know it's done?", text: "Filters survive reload\r" },
      { match: "Send it", text: "\r" },
    ],
  });
  try {
    expect(run.code).toBe(17);
    const received = JSON.parse(await readFile(capture, "utf8"));
    expect(received).toHaveLength(2);
    expect(received[0]).toBe("--");
    expect(received[1]).toContain("acceptance criteria");
    expect(received[1]).toContain("Keep 'quotes', $HOME and $(echo literal).");
    expect(received[1]).toContain("## Done when\nFilters survive reload");
    expect(received[1]).toContain("Agent CLIs: Cursor CLI");
    expect(run.output).toContain("Design and build this ace feature.");
  } finally {
    await rm(capture, { force: true });
    await rm(run.root, { recursive: true, force: true });
  }
});

it("without --provider, the picker offers only installed CLIs and OpenCode gets the prompt through its prompt flag", async () => {
  const capture = join(tmpdir(), `ace-wizard-opencode-${process.pid}.json`);
  const run = await drive({
    args: [],
    stubs: { opencode: recorder(capture, 0) },
    replies: [
      { match: "What do you need?", text: "\r" },
      { match: "What went wrong?", text: "-- starts with dashes\r\r" },
      { match: "What did you expect instead?", text: "\r" },
      { match: "Send it", text: "\r" },
      // Claude Code, Codex and Cursor are missing, so the cursor starts on OpenCode.
      { match: "not installed", text: "\r" },
    ],
  });
  try {
    expect(run.code).toBe(0);
    expect(run.output).toContain("not installed");
    expect(run.output).toContain("Opening OpenCode");
    const received = JSON.parse(await readFile(capture, "utf8"));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(/^--prompt=Find and fix the cause of this ace bug\./);
    expect(received[0]).toContain("## What happened\n-- starts with dashes");
    expect(received[0]).not.toContain("## Expected");
  } finally {
    await rm(capture, { force: true });
    await rm(run.root, { recursive: true, force: true });
  }
});

it("Ctrl-C inside the agent CLI interrupts the agent and ace waits for it instead of dying", async () => {
  const run = await drive({
    args: ["fix it", "--kind", "bug", "--provider", "claude"],
    stubs: {
      claude: `if (process.argv[2] === '--version') process.exit(0); process.on('SIGINT', () => { process.stdout.write('agent-interrupted\\n'); setTimeout(() => process.exit(5), 50); }); process.stdout.write('agent-ready\\n'); setInterval(() => {}, 1000);`,
    },
    replies: [
      { match: "Send it", text: "\r" },
      { match: "agent-ready", text: "\u0003" },
    ],
  });
  try {
    expect(run.output).toContain("agent-interrupted");
    expect(run.code).toBe(5);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

it("Ctrl-C leaves the template picker cleanly without generating or launching anything", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-wizard-cancel-"));
  const manager = new TerminalManager();
  const child = manager.openTerminal({
    shell: process.execPath,
    args: [cli, "triage"],
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
      if (!cancelled && output.includes("What do you need?")) {
        cancelled = true;
        child.write("\u0003");
      }
    }
  })();
  try {
    expect((await child.exited).code).toBe(0);
    await reading;
    expect(output).toContain("Nothing was sent.");
    expect(output).not.toContain("Opening");
    expect(await readdir(home)).toEqual([]);
  } finally {
    attachment.detach();
    await manager.closeAll();
    await rm(home, { recursive: true, force: true });
  }
});
