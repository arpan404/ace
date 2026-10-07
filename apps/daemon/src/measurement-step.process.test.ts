import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { z } from "zod";
import { apply, createThreadState, type Fact } from "@ace/core";
import { createCodexTranslator } from "@ace/adapter-codex";
import { createTranslator as claude } from "@ace/adapter-claude";
import { createPiTranslator } from "@ace/adapter-pi";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { CursorTranslator } from "@ace/adapter-cursor";
import { createAcpTranslator, genericQuirks } from "@ace/adapter-acp";
import { ScreenManager } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { McpScope, type ProviderKind } from "@ace/protocol";
import { startDaemon, readConfig, createDevThread } from "./index.ts";
import { measurementFrames } from "./testing/measurement-frames.ts";

async function fixture(
  provider: ProviderKind,
  options: { late?: boolean; omit?: boolean; large?: boolean; duplicate?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ace-measure-step-"));
  const original = await readFile(new URL("./testing/measurement-filmstrip.jpg", import.meta.url));
  const bytes = options.large
    ? Buffer.concat([original, Buffer.alloc(60_000 - original.length)])
    : original;
  const image = join(root, "filmstrip.jpg");
  await writeFile(image, bytes);
  let next = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: { FAKE_V2: "1", MEASUREMENT_FILMSTRIP_FILE: image },
    nextId: () => `screen-${++next}`,
    recordingDirectory: root,
    publishArtifact: async () => {},
  });
  let daemon = await startDaemon({
    config: readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
  });
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(root, "Measurements"));
  const state = createThreadState({ threadId: thread.id, config: { provider, silenceMs: 90_000 } });
  const ids = { next: (kind: string) => `${kind}-${++next}` };
  const feedFact = (fact: Fact) =>
    daemon.store.appendEvents(thread.id, apply(state, fact, { now: Date.now(), ids }));
  feedFact({
    type: "agent.seen",
    agent: "root",
    origin: "root",
    fidelity: "full",
    native: { provider },
    cwd: root,
  });
  const agentId = daemon.store.getThread(thread.id)?.rootAgentId;
  if (!agentId) throw new Error("No root");
  const init = { threadId: thread.id, rootKey: "root" };
  const translator =
    provider === "codex"
      ? createCodexTranslator(init)
      : provider === "claude"
        ? claude(init)
        : provider === "pi"
          ? createPiTranslator(init)
          : provider === "opencode"
            ? new OpenCodeTranslator(init)
            : provider === "cursor"
              ? new CursorTranslator(init)
              : createAcpTranslator(
                  { ...init, identity: { generation: "fake", cursor: 0 } },
                  genericQuirks,
                );
  await screen.enable(true);
  await screen.approve("dev.ace.test", true);
  const session = await screen.start({ kind: "window", bundleId: "dev.ace.test", windowId: 1 });
  screen.configureAccess({
    enabled: () => true,
    enable() {},
    list: () => [{ bundleId: "dev.ace.test", scope: "always", grantedAt: 0 }],
    allows: () => true,
    approve() {},
    async request() {
      throw new Error("Unexpected approval");
    },
    async foreground() {},
    audit() {},
  });
  const lifetime = new AbortController();
  const lease = daemon.mcp.openSession(
    McpScope.parse({
      sessionId: "offline",
      threadId: thread.id,
      agentId,
      capabilities: ["screen"],
    }),
    lifetime.signal,
  );
  const args = { sessionId: session.sessionId, observeMs: 2000 };
  const frames = measurementFrames(provider, args);
  if (options.duplicate)
    frames.before.push(
      ...measurementFrames(provider, args).before.slice(-1).map((frame) =>
        Object.assign({}, frame, {
          data: JSON.parse(
            JSON.stringify(frame.data)
              .replaceAll('"measure"', '"other"')
              .replaceAll('"id":"message"', '"id":"other-message"'),
          ),
        }),
      ),
    );
  const cli = spawnRawSupervised({
    command: process.execPath,
    args: [new URL("./testing/measurement-provider.ts", import.meta.url).pathname],
    cwd: root,
    env: {},
    name: `fake-${provider}-measurement`,
  });
  cli.stdin.write(
    JSON.stringify({
      url: daemon.mcp.url,
      bearer: lease.bearer,
      tool: "screen_measure_interaction",
      args,
      ...frames,
      late: options.late ?? false,
      omit: options.omit ?? false,
    }) + "\n",
  );
  let seq = 0;
  let result: unknown;
  try {
    for await (const line of createInterface({ input: cli.stdout })) {
      const message = z
        .object({
          kind: z.string(),
          frame: z
            .object({
              channel: z.string(),
              dir: z.enum(["recv", "send", "note"]),
              data: z.unknown(),
            })
            .optional(),
          result: z.unknown().optional(),
        })
        .parse(JSON.parse(line));
      if (message.frame) {
        const at = Date.now();
        for (const fact of translator.translate({ ...message.frame, seq: ++seq, t: at }, at))
          feedFact(fact);
      }
      if (message.kind === "result") result = message.result;
      if (message.kind === "done") break;
      cli.stdin.write("committed\n");
    }
    expect(await cli.exited).toMatchObject({ code: 0 });
    expect(result, JSON.stringify(result)).not.toMatchObject({ isError: true });
    return {
      get daemon() { return daemon; },
      async restart() { lease.end(); await daemon.close(); daemon = await startDaemon({ config: readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }) }); },
      thread,
      bytes,
      result,
      root,
      async close() {
        lease.end();
        await daemon.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await cli.stop();
    lease.end();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

for (const provider of ["codex", "claude", "opencode", "cursor", "pi", "acp"] as const)
  it(`${provider} attaches daemon measurement to the calling step and serves its thread-owned filmstrip`, async () => {
    const f = await fixture(provider, { large: provider === "codex" });
    try {
      const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
      const measured = items.filter((item) => item.type === "tool_call" && item.measurement);
      expect(measured).toHaveLength(1);
      const item = measured[0];
      if (item?.type !== "tool_call" || !item.measurement?.filmstrip)
        throw new Error("Missing step filmstrip");
      expect(item.call.status).toBe("succeeded");
      expect(item.measurement.verdict).toBe("smooth");
      expect(items.filter((entry) => entry.type === "notice" && entry.measurement)).toEqual([]);
      if (provider === "claude") expect(JSON.stringify(item.call.raw)).toContain('"tool_use"');
      if (provider === "codex") expect(item.call.raw.some((raw) => "blobRef" in raw)).toBe(true);
      const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
      const url = `${f.daemon.url.replace(/^ws/, "http")}/v1/attachments/${f.thread.id}/${item.measurement.filmstrip.sha256}/original`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
      await expect(
        f.daemon.context.uploads.handle("local", {
          op: "attachment.release",
          threadId: f.thread.id,
          sha256: item.measurement.filmstrip.sha256,
        }),
      ).rejects.toThrow();
      const retained = await f.daemon.context.uploads.attachment(
        "local",
        f.thread.id,
        item.measurement.filmstrip.sha256,
      );
      f.daemon.store.appendEvents(f.thread.id, [
        { type: "thread.client.updated", changes: { deletedAt: Date.now() } },
      ]);
      await f.daemon.context.uploads.releaseThread(f.thread.id);
      await f.daemon.context.uploads.collect();
      await expect(readFile(retained.path)).rejects.toThrow();
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).not.toBe(
        200,
      );
    } finally {
      await f.close();
    }
  });

it("late provider frames replace the standalone fallback with evidence on the exact tool step", async () => {
  const f = await fixture("claude", { late: true });
  try {
    const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
    expect(items.filter((item) => item.type === "tool_call" && item.measurement)).toHaveLength(1);
    expect(items.filter((item) => item.type === "notice" && item.measurement)).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each([{ omit: true }, { duplicate: true }])(
  "missing or ambiguous call correlation preserves a standalone measurement (%j)",
  async (options) => {
    const f = await fixture("claude", options);
    try {
      const items = Object.values(f.daemon.store.snapshotThread(f.thread.id).items);
      expect(items.filter((item) => item.type === "tool_call" && item.measurement)).toEqual([]);
      expect(items.filter((item) => item.type === "notice" && item.measurement)).toMatchObject([
        {
          complete: true,
          measurement: { verdict: "smooth", filmstrip: { mimeType: "image/jpeg" } },
        },
      ]);
    } finally {
      await f.close();
    }
  },
);

it("daemon evidence and attachment ownership survive restart and later provider upserts without raw results", async () => {
  const f = await fixture("claude");
  try {
    const original = Object.values(f.daemon.store.snapshotThread(f.thread.id).items).find((entry) => entry.type === "tool_call" && entry.measurement);
    if (original?.type !== "tool_call" || !original.measurement?.filmstrip) throw new Error("No measurement");
    await f.restart();
    const { measurement: _daemonEvidence, ...native } = original;
    f.daemon.store.appendEvents(f.thread.id, [{ type: "item.updated", item: { ...native, call: { ...native.call, title: "Provider updated the step", raw: [] } } }]);
    expect(f.daemon.store.snapshotThread(f.thread.id).items[original.id]).toMatchObject({ measurement: original.measurement, call: { title: "Provider updated the step", raw: [] } });
    const token = (await readFile(f.daemon.tokenPath, "utf8")).trim();
    const response = await fetch(`${f.daemon.url.replace(/^ws/, "http")}/v1/attachments/${f.thread.id}/${original.measurement.filmstrip.sha256}/original`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
  } finally { await f.close(); }
});
