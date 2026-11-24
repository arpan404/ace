// SPDX-License-Identifier: Apache-2.0

/**
 * Why this process test exists (porting guide E3-pi.2b, owner decision 1): no test rebooted a
 * home holding a Pi thread, so the E3 cross-mode gate had nothing to run for Pi. Each boot closes
 * the engine, closes the event database and opens both again, and the provider is a real child
 * process that starts and stops with the session — a restart the in-process helpers don't make.
 * Under `ACE_NATIVE_CROSS=ACE_SESSIONS` the three boots alternate the session backend, so one run
 * checks both swaps: native→TypeScript and TypeScript→native.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { createPiAdapter } from "@ace/adapter-pi";
import { Engine, Store } from "@ace/daemon";
import type { Frame, SessionContext } from "@ace/engine-api";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { expect, test, vi } from "vitest";
import { sessionFixture } from "../../../../packages/adapter-pi/src/testing/native-history.ts";
import { dispatch } from "./recovery-test-support.ts";
import { harness, scriptFrames } from "./test-support.ts";

const fakePi = fileURLToPath(
  new URL("../../../../packages/adapter-pi/src/testing/fake-pi.ts", import.meta.url),
);
const fakeAnswer = "hello\u2028world\u2029!";

/** One frame's JSON object, or `undefined` for a frame that is not an object. */
const Fields = z.record(z.string(), z.unknown());
function fields(frame: Frame): Record<string, unknown> | undefined {
  const parsed = Fields.safeParse(frame.data);
  return parsed.success ? parsed.data : undefined;
}

/** The RPC commands and replies one boot exchanged, in the order the engine saw them. */
type Wire = { at: number; dir: Frame["dir"]; data: Record<string, unknown> };

function wireOf(frames: readonly Frame[]): Wire[] {
  return frames.flatMap((frame, index) => {
    const data = fields(frame);
    return data === undefined ? [] : [{ at: index, dir: frame.dir, data }];
  });
}

function at(wire: readonly Wire[], index: number): Wire {
  const found = wire[index];
  if (found === undefined) throw new Error(`Missing frame ${index}`);
  return found;
}

/**
 * The boot continued boot 0's session: a `switch_session` to its file, answered
 * `{ cancelled: false }`, then a `get_state` reply carrying boot 0's file and session id. The
 * fake loads its own fixture at every start, so matching ids alone would prove nothing.
 */
function resumed(wire: readonly Wire[], file: string, id: string): void {
  const switched = wire.findIndex(
    (entry) => entry.dir === "send" && entry.data["type"] === "switch_session",
  );
  if (switched < 0) throw new Error("The boot sent no switch_session");
  const command = at(wire, switched);
  expect(command.data["sessionPath"]).toBe(file);
  const replyId = command.data["id"];
  expect(typeof replyId).toBe("string");
  const answered = wire.findIndex(
    (entry, index) => index > switched && entry.dir === "recv" && entry.data["id"] === replyId,
  );
  if (answered < 0) throw new Error("The switch_session was never answered");
  expect(at(wire, answered).data).toMatchObject({
    command: "switch_session",
    success: true,
    data: { cancelled: false },
  });
  const asked = wire.findIndex(
    (entry, index) =>
      index > answered && entry.dir === "send" && entry.data["type"] === "get_state",
  );
  if (asked < 0) throw new Error("The boot sent no get_state after the switch");
  const stateId = at(wire, asked).data["id"];
  const stated = wire.findIndex(
    (entry, index) => index > asked && entry.dir === "recv" && entry.data["id"] === stateId,
  );
  if (stated < 0) throw new Error("The get_state was never answered");
  expect(at(wire, stated).data).toMatchObject({
    command: "get_state",
    success: true,
    data: { sessionFile: file, sessionId: id },
  });
}

/** The thread's stored native session id: what the next boot hands back as `resume`. */
function storedNativeId(store: Store, threadId: ThreadId): string {
  const row = store
    .statement("SELECT native_session_id AS id FROM engine_sessions WHERE thread_id=?")
    .get(threadId);
  if (typeof row?.id !== "string") throw new Error("The thread stored no native session id");
  return row.id;
}

/** The assistant's replies as the transcript stored them, with the run and native session id. */
function storedReplies(store: Store, threadId: ThreadId) {
  const snapshot = store.snapshotThread(threadId);
  return snapshot.itemOrder.flatMap((itemId) => {
    const item = snapshot.items[itemId];
    if (item?.type !== "message" || item.role !== "assistant") return [];
    return [
      {
        text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        source: item.executionSource,
        run: item.runId === undefined ? undefined : snapshot.runs[item.runId],
      },
    ];
  });
}

function replies(store: Store, threadId: ThreadId): string[] {
  return storedReplies(store, threadId).map((reply) => reply.text);
}

/**
 * What the engine stored from the boot's own frames, read back through the Store's public thread
 * reads: the newest reply item, its run settled, and the native session id committed with both.
 */
function expectStored(
  store: Store,
  threadId: ThreadId,
  nativeSessionId: string,
  count: number,
): void {
  const stored = storedReplies(store, threadId);
  expect(stored).toHaveLength(count);
  const latest = stored.at(-1);
  if (latest === undefined) throw new Error("The thread stored no reply");
  expect(latest.text).toBe(fakeAnswer);
  expect(latest.source?.nativeSessionId).toBe(nativeSessionId);
  expect(latest.run).toMatchObject({
    state: "completed",
    executionSource: { nativeSessionId },
  });
  expect(latest.run?.endedAt).toBeTypeOf("number");
}

test("a Pi thread keeps its native session through two restarts of one home, resuming it both times", async () => {
  const piHome = mkdtempSync(join(tmpdir(), "ace-pi-restart-home-"));
  // The fake loads this at every start, as Pi loads the session it is told to resume.
  await writeFile(join(piHome, "source.jsonl"), sessionFixture(piHome, "native", 3));
  // The frames the current boot's engine received; a new boot starts a new set.
  let frames: Frame[] = [];
  const pi = createPiAdapter({
    cli: {
      installed: true,
      path: "synthetic-pi",
      version: "0.85.1",
      auth: "unknown",
      loginHint: "none",
    },
    sessionReferenceDir: join(piHome, "references"),
    runtime: {
      spawn: (options) =>
        spawnTextSupervised({
          ...options,
          command: process.execPath,
          args: [fakePi, ...(options.args ?? [])],
        }),
    },
  });
  const adapter = {
    ...pi,
    openSession(ctx: SessionContext) {
      return pi.openSession({
        ...ctx,
        env: { ...ctx.env, FAKE_PI_HOME: piHome },
        // Pi frames are not persisted (the Cursor journal only), so record each one once the
        // commit `ctx.onFrame` returns has resolved: a frame counts only after the engine
        // ingested it, and a failed or skipped commit records nothing.
        onFrame(frame: Frame) {
          return Promise.resolve(ctx.onFrame(frame)).then(() => {
            frames.push(frame);
          });
        },
      });
    },
  };
  const h = await harness([], scriptFrames(), {
    provider: "pi",
    nativeAdapter: adapter,
    discovery: {
      installed: true,
      path: "synthetic-pi",
      version: "0.85.1",
      auth: "unknown",
      loginHint: "none",
    },
  });
  let store = h.store;
  let engine: Engine = h.engine;
  try {
    // Boot 0: one turn, so the home holds both the transcript and Pi's reference.
    const id = await h.create("hello");
    await vi.waitFor(() => expect(store.getThread(id)?.status).toEqual({ state: "done" }));
    const reference = storedNativeId(store, id);
    expect(reference).toMatch(/^ace-pi-ref:[a-f0-9]{64}$/);
    const open = wireOf(frames)
      .filter((entry) => entry.dir === "recv" && entry.data["command"] === "get_state")
      .flatMap((entry) => {
        const parsed = Fields.safeParse(entry.data["data"]);
        return parsed.success ? [parsed.data] : [];
      })
      .at(-1);
    if (open === undefined) throw new Error("Boot 0 never answered get_state");
    const sessionFile = z.string().min(1).parse(open["sessionFile"]);
    const sessionId = z.string().min(1).parse(open["sessionId"]);
    expectStored(store, id, reference, 1);

    // Two restarts: the event database and the engine are reopened, then the thread continues.
    for (const boot of [1, 2]) {
      await engine.close();
      await store.close();
      frames = [];
      store = new Store(h.path);
      engine = new Engine(store, { registry: h.registry, clock: h.clock });
      await engine.flush();
      // 1. The stored native session id survived the boot untouched, and so did every reply the
      // engine stored with it: the item, its settled run and the run's native session id.
      expect(storedNativeId(store, id)).toBe(reference);
      expectStored(store, id, reference, boot);
      // 3. A new message produces a reply and the thread settles, so the continuation works.
      const before = replies(store, id).length;
      expect(
        dispatch(
          store,
          engine,
          { type: "thread.send", threadId: id, input: [{ type: "text", text: `boot ${boot}` }] },
          `boot-${boot}-send`,
        ).ok,
      ).toBe(true);
      await vi.waitFor(() => {
        expect(replies(store, id)).toHaveLength(before + 1);
        expect(store.getThread(id)?.status).toEqual({ state: "done" });
      });
      // The boot's reply, run and native session id, from the reopened store's thread reads.
      expectStored(store, id, reference, before + 1);
      // 2. The reopened session resumed boot 0's, rather than the fake's fresh start.
      resumed(wireOf(frames), sessionFile, sessionId);
      expect(storedNativeId(store, id)).toBe(reference);
    }

    // Under the gate, the log proves all three boots alternated the session backend.
    const log = process.env.ACE_NATIVE_CROSS_LOG;
    if (log !== undefined) {
      const boots = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          const parsed = z
            .object({
              root: z.string(),
              n: z.number(),
              switch: z.string(),
              effective: z.string(),
            })
            .safeParse(JSON.parse(line));
          return parsed.success ? [parsed.data] : [];
        })
        .filter((line) => line.root === h.home && line.switch === "ACE_SESSIONS");
      expect(boots.map((line) => line.n)).toEqual([0, 1, 2]);
      expect(boots[0]?.effective).toBe(process.env.ACE_SESSIONS ?? "");
      for (const [index, boot] of boots.entries())
        if (index > 0) expect(boot.effective).not.toBe(boots[index - 1]?.effective);
    }
  } finally {
    await engine.close();
    await store.close();
    await h.close();
    rmSync(piHome, { recursive: true, force: true });
  }
});
