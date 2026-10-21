import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from "node:fs/promises";
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
/** A stand-in agent CLI that records its arguments and folder on its real (non --version) launch. */
const recorder = (capture: string, exit: number) =>
  `import {writeFileSync} from 'node:fs'; if (process.argv[2] !== '--version') writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })); process.exit(${exit});`;
type Launch = { argv: string[]; cwd: string };

it("the agent starts in the triage folder with one line pointing at the playbook, and ace returns its exit code", async () => {
  const capture = join(tmpdir(), `ace-wizard-cursor-${process.pid}.json`);
  const run = await drive({
    args: ["--provider", "cursor"],
    stubs: { agent: recorder(capture, 17) },
    replies: [],
  });
  try {
    expect(run.code).toBe(17);
    expect(run.output).toContain("Starting Cursor CLI. It will ask what went wrong.");
    const launch = JSON.parse(await readFile(capture, "utf8")) as Launch;
    expect(launch.argv).toHaveLength(2);
    expect(launch.argv[0]).toBe("--");
    const playbook = join(launch.cwd, "PLAYBOOK.md");
    expect(launch.argv[1]).toContain(await realpath(playbook));
    expect(await readFile(playbook, "utf8")).toContain(join(launch.cwd, "FACTS.md"));
    expect(await readFile(join(launch.cwd, "FACTS.md"), "utf8")).toContain(
      "Agent CLIs: Cursor CLI",
    );
    await rm(launch.cwd, { recursive: true, force: true });
  } finally {
    await rm(capture, { force: true });
    await rm(run.root, { recursive: true, force: true });
  }
});

it("the picker offers only installed agents, and OpenCode gets the launch line through its prompt flag", async () => {
  const capture = join(tmpdir(), `ace-wizard-opencode-${process.pid}.json`);
  const run = await drive({
    args: [],
    stubs: { opencode: recorder(capture, 0) },
    // Claude Code, Codex and Cursor are missing, so the cursor starts on OpenCode.
    replies: [{ match: "Which agent should investigate?", text: "\r" }],
  });
  try {
    expect(run.code).toBe(0);
    expect(run.output).toContain("not installed");
    expect(run.output).toContain("Starting OpenCode");
    const launch = JSON.parse(await readFile(capture, "utf8")) as Launch;
    expect(launch.argv).toHaveLength(1);
    expect(launch.argv[0]).toMatch(/^--prompt=Read \S+PLAYBOOK\.md and follow it\./);
    await rm(launch.cwd, { recursive: true, force: true });
  } finally {
    await rm(capture, { force: true });
    await rm(run.root, { recursive: true, force: true });
  }
});

it("Ctrl-C inside the agent CLI interrupts the agent and ace waits for it instead of dying", async () => {
  const run = await drive({
    args: ["--provider", "claude"],
    stubs: {
      claude: `if (process.argv[2] === '--version') process.exit(0); process.on('SIGINT', () => { process.stdout.write('agent-interrupted\\n'); setTimeout(() => process.exit(5), 50); }); process.stdout.write('agent-ready\\n'); setInterval(() => {}, 1000);`,
    },
    replies: [{ match: "agent-ready", text: "\u0003" }],
  });
  try {
    expect(run.output).toContain("agent-interrupted");
    expect(run.code).toBe(5);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

it("Ctrl-C at the agent picker leaves cleanly without launching anything", async () => {
  const capture = join(tmpdir(), `ace-wizard-cancel-${process.pid}.json`);
  const run = await drive({
    args: [],
    stubs: { opencode: recorder(capture, 0) },
    replies: [{ match: "Which agent should investigate?", text: "\u0003" }],
  });
  try {
    expect(run.code).toBe(0);
    expect(run.output).toContain("Nothing was changed or started.");
    expect(run.output).not.toContain("Starting");
    await expect(readFile(capture, "utf8")).rejects.toThrow();
  } finally {
    await rm(capture, { force: true });
    await rm(run.root, { recursive: true, force: true });
  }
});
