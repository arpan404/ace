import { expect, test } from "vitest";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { createFileSink, createLogger, logFields, logMetadata } from "@ace/diagnostics";
import { createRedactor } from "@ace/redaction";
import { codexCapabilities } from "@ace/adapter-codex";
import { protocolNoiseCases } from "./protocol-noise-test-support.ts";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { until } from "./test-support.ts";
import { cursorSdkDiscovery } from "../testing/cursor-sdk-discovery.ts";

for (const corpus of protocolNoiseCases.filter((c) => c.provider !== "acp")) {
  test(`${corpus.name} unknown frames survive size-limited redacted daemon records without transcript rows`, async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-provider-diagnostics-"));
    const registry = new AdapterRegistry();
    const entry = join(home, "diagnostics-sdk.mjs");
    if (corpus.provider === "cursor")
      await writeFile(
        entry,
        `
import {createInterface} from 'node:readline';
const frames = ${JSON.stringify([...corpus.setup, ...corpus.noise, ...corpus.after].map((frame) => frame.data))};
const pending = new Map();
let generation;
let serial = 0;
const output = value => console.log(JSON.stringify(value));
async function request(message) {
  if (message.method === 'open') {
    generation = message.params.generation;
    output({id:message.id,result:{agentId:'diagnostics-sdk'}});
  } else if (message.method === 'send') {
    for (const frame of frames) {
      const id = 'frame-' + ++serial;
      const committed = new Promise(resolve => pending.set(id, resolve));
      output({id,method:'frame',params:{...frame,generation,operationId:message.params.operationId,agentId:'diagnostics-sdk'}});
      await committed;
    }
    output({id:message.id,result:{runId:'diagnostics-run'}});
  } else output({id:message.id,result:message.method === 'status' ? {status:'logged-out',source:'none'} : {disposed:true}});
}
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  const resolve = pending.get(message.id);
  if (resolve) { pending.delete(message.id); resolve(); }
  else void request(message);
});`,
      );
    registry.register(
      createScriptedAdapter({
        provider: corpus.provider,
        capabilities: codexCapabilities({
          installed: true,
          auth: "logged_in",
          version: "0.159.1",
          loginHint: "unused",
        }),
        createTranslator: corpus.create,
        steps: [
          {
            on: "send",
            frames: [...corpus.setup, ...corpus.noise, ...corpus.after].map((frame, index) => {
              const payload =
                frame.channel === "sdk"
                  ? new ProviderPayload(JSON.stringify(frame.data))
                  : undefined;
              return Object.assign(
                {},
                frame,
                { seq: index + 1, t: index + 1 },
                payload ? { data: payload.data, payload } : {},
              );
            }),
          },
        ],
      }),
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "debug" }),
      modelInstances: [],
      engine: {
        registry,
        ...(corpus.provider === "cursor"
          ? { cursor: { entry, env: {}, policy: "full-access", discovery: cursorSdkDiscovery } }
          : {}),
      },
    });
    const client = new Client(daemon.url);
    try {
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("device"),
        token: await readFile(daemon.tokenPath, "utf8"),
      });
      await until(client, (m) => m.type === "welcome");
      const done = Promise.withResolvers<void>();
      const notices: string[] = [];
      const unsubscribe = daemon.store.subscribe((events) => {
        for (const event of events)
          if (event.payload.type === "item.created" && event.payload.item.type === "notice") {
            notices.push(event.payload.item.text);
            done.resolve();
          }
        if (
          events.some(
            (e) =>
              (e.payload.type === "item.delta" && e.payload.append === "Still here") ||
              (e.payload.type === "item.created" &&
                e.payload.item.type === "message" &&
                e.payload.item.parts.some(
                  (part) => part.type === "text" && part.text === "Still here",
                )),
          )
        )
          done.resolve();
      });
      const workspaceId = daemon.store.createWorkspace(home, "Workspace");
      client.send({
        type: "command",
        command: Command.parse({
          id: "send",
          deviceId: "device",
          payload: {
            type: "thread.create",
            workspaceId,
            provider: corpus.provider,
            permissionMode: "full-access",
            input: [{ type: "text", text: "fixture input" }],
          },
        }),
      });
      expect(
        await until(client, (m) => m.type === "commandResult" && m.commandId === "send"),
      ).toMatchObject({ ok: true });
      await done.promise;
      unsubscribe();
      expect(notices).toEqual([]);
      await client.close();
      await daemon.close();
      const logs = (await readFile(join(home, "logs", "ace.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.includes('"message":"Provider diagnostic"'))
        .join("\n");
      expect(logs).toContain("future/extension");
      expect(logs).toContain("future evidence");
      expect(logs).not.toContain("synthetic-secret");
      expect(logs).not.toContain("x".repeat(10000));
      expect(logs).not.toContain("<UNPREPARED OBJECT OMITTED>");
    } finally {
      await client.close();
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

// Mutation: disable file rotation/retention or bypass secret/oversize normalization.
// Not executed (tests run at merge).
test("sustained provider diagnostics keep recent evidence within the file retention cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-provider-log-retention-"));
  const context = { home: directory };
  const totalBytes = 4096;
  const sink = await createFileSink({ directory, fileBytes: 2048, totalBytes, context });
  const logger = createLogger({
    sink,
    now: () => 0,
    redact: createRedactor(context),
    level: "debug",
  });
  try {
    for (let index = 0; index < 40; index++) {
      logger.log(
        "debug",
        "Provider diagnostic",
        logFields([
          [
            "raw",
            [
              logMetadata({
                type: "future/extension",
                data: {
                  marker: `provider-record-${index}`,
                  detail: "d".repeat(600),
                  api_key: "synthetic-secret",
                  oversized: "x".repeat(10000),
                },
              }),
            ],
          ],
        ]),
      );
      await logger.flush();
    }
    await logger.close();
    const files = (await readdir(directory)).filter((name) => /^ace(?:\.\d+)?\.jsonl$/.test(name));
    const sizes = await Promise.all(files.map((name) => stat(join(directory, name))));
    expect(sizes.every((entry) => entry.size <= 2048)).toBe(true);
    expect(sizes.reduce((bytes, entry) => bytes + entry.size, 0)).toBeLessThanOrEqual(totalBytes);
    const evidence = (
      await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")))
    ).join("\n");
    expect(evidence).toContain("provider-record-39");
    expect(evidence).not.toContain("provider-record-0");
    expect(evidence).not.toContain("synthetic-secret");
    expect(evidence).not.toContain("x".repeat(10000));
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
