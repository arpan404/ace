import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAcpInstance, openRegistry } from "@ace/accounts";
import { probeOutput } from "@ace/provider-kit/process";
import { refreshAcpAgentAuth } from "./acp-agent-status.ts";
import { cursorAgentSignedIn } from "./acp-agent-cli.ts";

const cursor = {
  acpAgentId: "official:cursor",
  installationId: "cursor-install",
  instanceId: "cursor-install:default",
};
const gemini = {
  acpAgentId: "official:gemini",
  installationId: "gemini-install",
  instanceId: "gemini-install:default",
};

/** A `cursor-agent` whose `status --format json` reports what the test wrote to its state file. */
async function fakeCursorAgent(home: string) {
  const command = join(home, "cursor-agent");
  const state = join(home, "status.json");
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'status --format json') process.exit(64);
process.stdout.write(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
`,
    { mode: 0o700 },
  );
  return { command, report: (body: string) => writeFile(state, body) };
}

test("Cursor's CLI agent reads signed in or out from its own status, and only a change is recorded", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-acp-status-"));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  try {
    const agent = await fakeCursorAgent(home);
    for (const identity of [cursor, gemini])
      await registry.register(createAcpInstance({ identity, label: "Agent", userHome: home }));
    const refresh = () =>
      refreshAcpAgentAuth({
        registry,
        installed: [
          { metadata: cursor, command: agent.command },
          // An agent with no status command of its own is left as it is.
          { metadata: gemini, command: agent.command },
        ],
        env: { HOME: home, PATH: "" },
        now: () => 1000,
        probe: probeOutput,
      });
    await agent.report(JSON.stringify({ status: "authenticated", isAuthenticated: true }));
    await refresh();
    expect(registry.get(cursor.instanceId)?.quota.auth).toBe("logged_in");
    expect(registry.get(gemini.instanceId)?.quota.auth).toBe("unknown");
    const revision = registry.get(cursor.instanceId)?.instance.loginRevision;
    await refresh();
    expect(registry.get(cursor.instanceId)?.instance.loginRevision).toBe(revision);
    await agent.report(JSON.stringify({ status: "unauthenticated", isAuthenticated: false }));
    await refresh();
    expect(registry.get(cursor.instanceId)?.quota.auth).toBe("logged_out");
    // Output it can't read changes nothing.
    await agent.report("not json");
    await refresh();
    expect(registry.get(cursor.instanceId)?.quota.auth).toBe("logged_out");
  } finally {
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a CLI-run task asks cursor-agent whether its own login is signed in", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cursor-signed-in-"));
  try {
    const agent = await fakeCursorAgent(home);
    const signal = new AbortController().signal;
    await agent.report(JSON.stringify({ isAuthenticated: false }));
    expect(await cursorAgentSignedIn(agent.command, { PATH: "" }, signal)).toBe(false);
    await agent.report(JSON.stringify({ isAuthenticated: true }));
    expect(await cursorAgentSignedIn(agent.command, { PATH: "" }, signal)).toBe(true);
    expect(await cursorAgentSignedIn(join(home, "missing"), { PATH: "" }, signal)).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
