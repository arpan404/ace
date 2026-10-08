import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { Capabilities, Command, type HistoryProvider, type ServerMessage } from "@ace/protocol";
import type { ProviderAdapter } from "@ace/engine-api";
import { AdapterRegistry, startDaemon } from "./index.ts";
import { commandContext } from "./commands.ts";
import { readConfig } from "./config.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const native = "00000000-0000-4000-8000-000000000033";
const capabilities = Capabilities.parse({
  resume: true,
  steer: false,
  interruptCascades: false,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: false,
  backgroundVisibility: "none",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
  permissions: { modes: ["auto-review"], nativeAutoReview: false, toolGate: true },
});

async function write(path: string, records: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}
async function fixture(provider: Exclude<HistoryProvider, "cursor">) {
  const root = await mkdtemp(join(tmpdir(), "ace-past-sessions-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const home = join(root, "provider");
  const path =
    provider === "claude"
      ? join(home, "projects/p/session.jsonl")
      : provider === "codex"
        ? join(home, "sessions/2026/10/07/rollout.jsonl")
        : join(home, "storage/session/p", `${native}.json`);
  const records =
    provider === "claude"
      ? [
          {
            type: "user",
            sessionId: native,
            cwd,
            message: { role: "user", content: "saved prompt" },
          },
        ]
      : provider === "codex"
        ? [
            { type: "session_meta", payload: { id: native, cwd } },
            {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "saved prompt" }],
              },
            },
          ]
        : [{ id: native, directory: cwd, title: "saved prompt", time: { updated: 1000 } }];
  await write(path, records);
  if (provider === "opencode") {
    await write(join(home, "storage/message", native, "message.json"), [
      { id: "message", sessionID: native, role: "user" },
    ]);
    await write(join(home, "storage/part/message/text.json"), [
      { type: "text", text: "saved prompt" },
    ]);
  }
  const receipt = join(root, "provider-effects.jsonl");
  const reply = z.object({ text: z.string() });
  const adapter: ProviderAdapter = {
    provider,
    capabilities: () => capabilities,
    createTranslator: () => ({
      tick: () => [],
      translate: (frame) => {
        const decoded = reply.safeParse(frame.data);
        return decoded.success
          ? [
              { type: "turn.started", agent: "root", trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: `reply-${frame.seq}`,
                draft: {
                  type: "message",
                  role: "assistant",
                  parts: [{ type: "text", text: decoded.data.text }],
                  complete: true,
                },
              },
              { type: "turn.ended", agent: "root", outcome: "completed" },
            ]
          : [];
      },
    }),
    openSession: async (ctx) => {
      if (ctx.resume?.nativeSessionId !== native)
        throw new Error("Native resume identity was lost");
      await appendFile(
        receipt,
        JSON.stringify({
          event: "opened",
          native: ctx.resume.nativeSessionId,
          home: ctx.instanceHomeDir,
          cwd: ctx.cwd,
          instance: ctx.instanceId,
          codexHome: ctx.env?.CODEX_HOME,
          claudeHome: ctx.env?.CLAUDE_CONFIG_DIR,
          dataHome: ctx.env?.XDG_DATA_HOME,
        }) + "\n",
      );
      let seq = 0;
      return {
        nativeSessionId: native,
        send: async (input) => {
          await appendFile(receipt, JSON.stringify({ event: "sent", input }) + "\n");
          await ctx.onFrame({
            seq: ++seq,
            t: seq,
            dir: "recv",
            channel: "fixture",
            data: { text: "continued answer" },
          });
        },
        interrupt: async () => {},
        resolve: async () => {},
        stopTask: async () => {},
        close: async () => ctx.onExit({ deliberate: true }),
      };
    },
  };
  const launch = async (resume = true, historyHome = home) => {
    const registry = new AdapterRegistry();
    registry.register(
      { ...adapter, capabilities: () => ({ ...capabilities, resume }) },
      { installed: true, auth: "unknown", loginHint: "Fixture only" },
    );
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: join(root, "ace"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      modelInstances: [],
      toolkits: [],
      engine: { registry },
      history: { instances: [{ id: "fixture", provider, homeDir: historyHome }] },
    });
    cleanup.push(daemon.close);
    await daemon.history?.startScan();
    return daemon;
  };
  return { root, home, cwd, path, records, receipt, launch };
}
function imported(reply: ServerMessage) {
  if (reply.type !== "history.import" || reply.status !== "imported")
    throw new Error("Import failed");
  return reply.threadId;
}
for (const provider of ["claude", "codex", "opencode"] as const) {
  test(`${provider} history imports once, resumes in its original home, and remains sendable after restart`, async () => {
    const f = await fixture(provider);
    let daemon = await f.launch();
    const history = daemon.history;
    if (!history) throw new Error("History unavailable");
    const workspaceId = daemon.store.createWorkspace(f.cwd, "Project");
    const signal = new AbortController().signal;
    const page = await history.handle({ type: "history.list", cwd: f.cwd, limit: 10 }, signal);
    if (page.type !== "history.list") throw new Error("Missing sessions");
    const source = page.sessions[0];
    if (!source) throw new Error("Missing session");
    expect(source.continuation).toEqual({ status: "supported" });
    const request = { type: "history.import" as const, sourceId: source.id, workspaceId };
    const id = imported(await history.handle(request, signal));
    expect(imported(await history.handle(request, signal))).toBe(id);
    const original = daemon.store.readItems(id, Number.MAX_SAFE_INTEGER, 10);
    expect(
      original.items.some(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text === "saved prompt"),
      ),
    ).toBe(true);
    expect(
      await history.handle(
        { type: "history.continue", threadId: id, mode: "resume", input: [], delivery: "queue" },
        signal,
      ),
    ).toMatchObject({ status: "continued", nativeSessionId: native });
    const effect = z
      .object({
        event: z.literal("opened"),
        home: z.string(),
        cwd: z.string(),
        instance: z.string(),
        native: z.string(),
        codexHome: z.string().optional(),
        claudeHome: z.string().optional(),
        dataHome: z.string().optional(),
      })
      .parse(JSON.parse((await readFile(f.receipt, "utf8")).trim()));
    expect(effect).toMatchObject({ home: f.home, cwd: f.cwd, instance: "fixture", native });
    if (provider === "codex") expect(effect.codexHome).toBe(f.home);
    if (provider === "claude") expect(effect.claudeHome).toBe(f.home);
    if (provider === "opencode") expect(effect.dataHome).toBe(dirname(f.home));
    expect(daemon.store.getThread(id)?.rootAgentId).toBe(
      daemon.store.readItems(id, Number.MAX_SAFE_INTEGER, 10).items[0]?.agentId,
    );
    await daemon.close();
    daemon = await f.launch();
    const command = Command.parse({
      id: "next-message",
      deviceId: "fixture-device",
      payload: {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "continue the work" }],
        delivery: "queue",
      },
    });
    const result = daemon.engine?.handler.handle(command, commandContext(daemon.store));
    expect(result).toMatchObject({ ok: true });
    await daemon.engine?.flush();
    expect(
      daemon.store
        .readItems(id, Number.MAX_SAFE_INTEGER, 20)
        .items.some(
          (item) =>
            item.type === "message" &&
            item.parts.some((part) => part.type === "text" && part.text === "continued answer"),
        ),
    ).toBe(true);
    expect(await readFile(f.path, "utf8")).toBe(
      f.records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  });
  test(`${provider} startup reuses its saved index and reads only the changed session`, async () => {
    const f = await fixture(provider);
    let daemon = await f.launch();
    await daemon.close();
    daemon = await f.launch();
    expect(daemon.history?.scanStatus().stats).toMatchObject({ reads: 0, skipped: 1 });
    const changedScan = Promise.withResolvers<void>();
    const stop = daemon.history?.subscribeScan((scan) => {
      if (scan.state === "ready" && scan.stats.reads === 1) changedScan.resolve();
    });
    await write(
      f.path,
      provider === "opencode"
        ? [{ id: native, directory: f.cwd, title: "changed title", time: { updated: 2000 } }]
        : [
            ...f.records,
            provider === "claude"
              ? { type: "ai-title", sessionId: native, aiTitle: "changed title" }
              : {
                  type: "response_item",
                  payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "another saved prompt" }],
                  },
                },
          ],
    );
    await daemon.history?.startScan();
    await changedScan.promise;
    stop?.();
  });
}
test("a provider without native resume offers import only and never opens a session", async () => {
  const f = await fixture("codex");
  const daemon = await f.launch(false);
  const signal = new AbortController().signal;
  const page = await daemon.history?.handle(
    { type: "history.list", cwd: f.cwd, limit: 10 },
    signal,
  );
  if (page?.type !== "history.list" || !page.sessions[0]) throw new Error("Missing history");
  expect(page.sessions[0].continuation?.status).toBe("unsupported");
  const workspaceId = daemon.store.createWorkspace(f.cwd, "Project");
  const result = await daemon.history?.handle(
    { type: "history.import", sourceId: page.sessions[0].id, workspaceId },
    signal,
  );
  if (!result) throw new Error("Missing import");
  const id = imported(result);
  expect(
    await daemon.history?.handle(
      { type: "history.continue", threadId: id, mode: "resume", input: [], delivery: "queue" },
      signal,
    ),
  ).toMatchObject({ status: "unsupported" });
  await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an imported thread refuses a rebound history home after restart", async () => {
  const f = await fixture("claude");
  let daemon = await f.launch();
  const signal = new AbortController().signal;
  const workspaceId = daemon.store.createWorkspace(f.cwd, "Project");
  const page = await daemon.history?.handle(
    { type: "history.list", cwd: f.cwd, limit: 10 },
    signal,
  );
  if (page?.type !== "history.list" || !page.sessions[0]) throw new Error("Missing history");
  const result = await daemon.history?.handle(
    { type: "history.import", sourceId: page.sessions[0].id, workspaceId },
    signal,
  );
  if (!result) throw new Error("Missing import");
  const id = imported(result);
  await daemon.history?.handle(
    { type: "history.continue", threadId: id, mode: "resume", input: [], delivery: "queue" },
    signal,
  );
  await daemon.close();
  const differentHome = join(f.root, "different-provider-home");
  await write(join(differentHome, "projects/p/session.jsonl"), f.records);
  daemon = await f.launch(true, differentHome);
  const command = Command.parse({
    id: "refuse-rebound",
    deviceId: "fixture-device",
    payload: {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "continue" }],
      delivery: "queue",
    },
  });
  expect(daemon.engine?.handler.handle(command, commandContext(daemon.store))).toMatchObject({
    ok: true,
  });
  await daemon.engine?.flush();
  const effects = (await readFile(f.receipt, "utf8")).trim().split("\n");
  expect(effects).toHaveLength(1);
  expect(daemon.engine?.commandExecution(command.id)).toBe("queued");
  expect(daemon.store.getThread(id)?.status.state).toBe("waiting");
});
