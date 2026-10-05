import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createInstance, openRegistry } from "@ace/accounts";
import { UsageStore } from "@ace/usage";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command } from "@ace/protocol";
import { startDaemon, AdapterRegistry } from "./index.ts";
import { commandContext } from "./commands.ts";
import { scriptFrames, start, end } from "./engine/test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
test("reannouncing a retained agent preserves usage counters and cannot move it to another thread", () => {
  const store = new UsageStore(":memory:");
  const at = Date.parse("2026-10-03T12:00:00Z");
  const agent = {
    type: "agent.created",
    id: "root",
    parent: null,
    model: null,
    provider: "claude",
  };
  const usage = (inputTokens: number) => ({
    type: "usage.updated",
    agentId: agent.id,
    inputTokens,
    outputTokens: 0,
    counterMode: "cumulative",
  });
  try {
    store.ingest({
      afterSeq: 0,
      throughSeq: 4,
      events: [
        {
          seq: 1,
          at,
          threadId: "thread",
          payload: { type: "thread.created", workspace: "w", provider: agent.provider },
        },
        { seq: 2, at, threadId: "thread", payload: agent },
        {
          seq: 3,
          at,
          threadId: "thread",
          payload: { type: "run.started", agent: "root", run: "run" },
        },
        { seq: 4, at, threadId: "thread", payload: usage(10) },
      ],
    });
    store.ingest({
      afterSeq: 4,
      throughSeq: 6,
      events: [
        { seq: 5, at, threadId: "thread", payload: agent },
        { seq: 6, at, threadId: "thread", payload: usage(15) },
      ],
    });
    expect(
      store.summary({ from: "2026-10-03", to: "2026-10-03" }).rows[0]?.totals.inputTokens,
    ).toBe(15);
    expect(() =>
      store.ingest({
        afterSeq: 6,
        throughSeq: 8,
        events: [
          {
            seq: 7,
            at,
            threadId: "other",
            payload: { type: "thread.created", workspace: "w", provider: agent.provider },
          },
          { seq: 8, at, threadId: "other", payload: agent },
        ],
      }),
    ).toThrow();
    expect(store.cursor()).toBe(6);
    expect(
      store.summary({ from: "2026-10-03", to: "2026-10-03", filters: { thread: ["thread"] } })
        .rows[0]?.totals.inputTokens,
    ).toBe(15);
  } finally {
    store.close();
  }
});
test("daemon binds a provider default selected after startup and retains that account after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-account-launch-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const account = createInstance({
    id: "selected",
    provider: "codex",
    label: "Selected",
    homeDir: join(home, "codex"),
  });
  await mkdir(account.homeDir);
  const observations: {
    home: string;
    key: string;
    instance: string | undefined;
    resume: string | undefined;
  }[] = [];
  const open = async () => {
    const frames = scriptFrames();
    const frame = frames.frame(start, end);
    const payload = new ProviderPayload(JSON.stringify(frame.data));
    const scripted = createScriptedAdapter({
      provider: "codex",
      nativeSessionId: "native-account",
      capabilities: {
        steer: false,
        interruptCascades: false,
        resume: true,
        fork: false,
        subagentTranscripts: false,
        backgroundTaskControl: false,
        backgroundVisibility: "none",
        planMode: false,
        tokenUsage: false,
        imageInput: false,
        rewindFiles: false,
      },
      createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
      steps: [{ on: "send", frames: [{ ...frame, payload, data: payload.data }] }],
    });
    const adapters = new AdapterRegistry();
    adapters.register(
      {
        ...scripted,
        async openSession(context) {
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              "-e",
              "process.stdout.write(JSON.stringify({home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY||''}))",
            ],
            { env: { ...process.env, ...context.env } },
          );
          const environment = z
            .object({ home: z.string(), key: z.string() })
            .parse(JSON.parse(stdout));
          observations.push({
            ...environment,
            instance: context.instanceId,
            resume: context.resume?.nativeSessionId,
          });
          return scripted.openSession({
            ...context,
            onFrame(nativeFrame) {
              const certificate = new ProviderPayload(JSON.stringify(nativeFrame.data));
              context.onFrame({ ...nativeFrame, payload: certificate, data: certificate.data });
            },
          });
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    return startDaemon({
      config: {
        dataDir: home,
        host: "127.0.0.1",
        port: 0,
        remotePort: 0,
        listen: "local",
        logLevel: "silent",
      },
      engine: { registry: adapters },
    });
  };
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key-must-be-masked");
  cleanup.push(async () => {
    vi.unstubAllEnvs();
  });
  const first = await open();
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  await registry.register(account);
  registry.selectProvider("codex", account.id);
  registry.ingest(account.id, {
    provider: "codex",
    observedAt: 1,
    timeZone: "UTC",
    payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
  });
  registry.close();

  cleanup.push(() => first.close());
  const workspaceId = first.store.createWorkspace(home, "workspace");
  const create = Command.parse({
    id: randomUUID(),
    deviceId: "host",
    createdAt: 1,
    payload: {
      type: "thread.create",
      workspaceId,
      provider: "codex",
      input: [{ type: "text", text: "synthetic" }],
    },
  });
  expect(first.engine?.handler.handle(create, commandContext(first.store)).ok).toBe(true);
  await first.engine?.flush();
  const thread = first.store.listThreads()[0];
  if (!thread) throw new Error("Missing thread");
  expect(thread.status.state).toBe("done");
  await first.close();
  const second = await open();
  cleanup.push(() => second.close());
  const send = Command.parse({
    id: randomUUID(),
    deviceId: "host",
    createdAt: 2,
    payload: {
      type: "thread.send",
      threadId: thread.id,
      input: [{ type: "text", text: "again" }],
      delivery: "queue",
    },
  });
  expect(second.engine?.handler.handle(send, commandContext(second.store)).ok).toBe(true);
  await second.engine?.flush();
  expect(second.store.getThread(thread.id)?.status.state).toBe("done");
  expect(observations).toEqual([
    { home: await realpath(account.homeDir), key: "", instance: "selected", resume: undefined },
    {
      home: await realpath(account.homeDir),
      key: "",
      instance: "selected",
      resume: "native-account",
    },
  ]);
});
