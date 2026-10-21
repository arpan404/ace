import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { startDaemon, readConfig, AdapterRegistry } from "./index.ts";
import { Client } from "./socket-test-support.ts";

async function next(client: Client, matches: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await client.next();
    if (message.type === "terminal.result" && !message.ok) throw new Error(message.error);
    if (matches(message)) return message;
  }
}

it("an app handoff runs the installed CLI interactively with literal prompt text and no durable command", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-triage-terminal-"));
  const capture = join(root, "received.json");
  await writeFile(
    join(root, "agent"),
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv[2] !== "--") process.exit(0);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdin.once("data", () => process.exit(17));
process.stdout.write("handoff-ready\\n");
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${root}:/usr/bin:/bin`);
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(root, "data"), ACE_PORT: "0" }),
    engine: { registry: new AdapterRegistry() },
    modelInstances: [],
    diagnostics: { doctor: async () => ({ at: 1, checks: [] }), toolchains: async () => [] },
  });
  const token = await readFile(daemon.tokenPath, "utf8");
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("triage-owner"),
      token,
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    const head = daemon.store.headSeq();
    const prompt = "--model literal; $(echo untouched)\nKeep 'quotes' and $HOME.";
    client.send({
      type: "diagnostics.request",
      requestId: "launch",
      operation: "launch",
      provider: "cursor",
      prompt,
    });
    const launch = await next(client, (message) => message.type === "diagnostics.result");
    if (launch.type !== "diagnostics.result" || !launch.terminalId)
      throw new Error(JSON.stringify(launch));
    const terminalId = launch.terminalId;
    client.send({
      type: "terminal.request",
      requestId: "subscribe",
      operation: { op: "subscribe", terminalId, subscriptionId: "triage", fromOffset: 0 },
    });
    await next(
      client,
      (message) =>
        message.type === "terminal.output" &&
        message.event.type === "data" &&
        message.event.data.includes("handoff-ready"),
    );
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
      args: ["--", prompt],
      cwd: homedir(),
    });
    client.send({
      type: "terminal.request",
      requestId: "finish",
      operation: { op: "write", terminalId, data: "finish\n" },
    });
    expect(
      await next(
        client,
        (message) => message.type === "terminal.output" && message.event.type === "exit",
      ),
    ).toMatchObject({ event: { status: { code: 17 } } });
    expect(daemon.store.headSeq()).toBe(head);
  } finally {
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
