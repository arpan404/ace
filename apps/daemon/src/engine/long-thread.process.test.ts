import { expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

test("frames queued while history owns SQLite commit after publication without poisoning the session", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const ctx = h.contexts[0];
    if (!ctx) throw new Error("Missing context");
    h.store.setHistoryWriting(true);
    const committed = ctx.onFrame(
      frames.frame(
        { type: "item.delta", agent: "root", item: "live", field: "text", append: "preserved" },
        end,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    h.store.setHistoryWriting(false);
    await h.engine.flush();
    await committed;
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(
      Object.values(h.store.snapshotThread(id).items).some(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text === "preserved"),
      ),
    ).toBe(true);
  } finally {
    h.store.setHistoryWriting(false);
    await h.close();
  }
});

test("a transient SQLite writer lock retries before translation and commits each append once", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  const writer = new DatabaseSync(h.path);
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing session");
    h.store.statement("PRAGMA busy_timeout=0").get();
    writer.exec("BEGIN IMMEDIATE");
    const ack = context.onFrame(
      frames.frame(
        { type: "item.delta", agent: "root", item: "busy", field: "text", append: "once" },
        end,
      ),
    );
    const flushed = h.engine.flush();
    await new Promise((resolve) => setImmediate(resolve));
    writer.exec("COMMIT");
    h.clock.advance(1100);
    await flushed;
    await ack;
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(
      Object.values(h.store.snapshotThread(id).items).filter(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text === "once"),
      ),
    ).toHaveLength(1);
  } finally {
    writer.close();
    await h.close();
  }
});

test("acknowledged coalesced appends survive SIGKILL without a final flush", async () => {
  const { fork } = await import("node:child_process");
  const { once } = await import("node:events");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../index.ts");
  const { ThreadId } = await import("@ace/protocol");
  const home = await mkdtemp(join(tmpdir(), "ace-committed-kill-"));
  const path = join(home, "events.sqlite");
  const child = fork(new URL("./long-thread-child.ts", import.meta.url), [path, home], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error("Fixture exited before acknowledging");
      }),
    ]);
    child.kill("SIGKILL");
    await exited;
    const store = new Store(path);
    try {
      const view = store.snapshotThread(ThreadId.parse("committed-thread"));
      expect(
        Object.values(view.items).some(
          (item) =>
            item.type === "message" &&
            item.parts.some((part) => part.type === "text" && part.text === "x".repeat(1000)),
        ),
      ).toBe(true);
    } finally {
      await store.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("a transport signal before each token keeps liveness while appends share durable writes", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing session");
    const afterSeq = h.store.headSeq();
    const acknowledgements = Array.from({ length: 1000 }, () =>
      context.onFrame(
        frames.frame(
          { type: "signal", agent: "root" },
          { type: "item.delta", agent: "root", item: "signals", field: "text", append: "x" },
        ),
      ),
    );
    await h.engine.flush();
    await Promise.all(acknowledgements);
    expect(
      h.store
        .readEvents({ afterSeq, limit: 2000 })
        .filter((event) => event.payload.type === "item.delta").length,
    ).toBeLessThan(10);
    expect(h.store.getThread(id)?.status.state).toBe("working");
    h.clock.advance(1101);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("unresponsive");
  } finally {
    await h.close();
  }
});

test("resolving one thread's approval does not decode unrelated thread snapshots", async () => {
  const frames = scriptFrames();
  const { question } = await import("./test-support.ts");
  const h = await harness([{ on: "send", frames: [frames.frame(start, question)] }], frames);
  let unrelated: Awaited<ReturnType<typeof h.create>> | undefined;
  let saved: { state: string; seq: number } | undefined;
  try {
    const owner = await h.create();
    unrelated = await h.create();
    const row = h.store
      .statement("SELECT state,seq FROM thread_state WHERE thread_id=?")
      .get(unrelated);
    if (!row) throw new Error("Missing snapshot");
    saved = { state: String(row.state), seq: Number(row.seq) };
    h.store
      .statement("UPDATE thread_state SET state='unavailable',seq=seq+1 WHERE thread_id=?")
      .run(unrelated);
    const interaction = Object.values(h.store.snapshotThread(owner).interactions)[0];
    if (!interaction) throw new Error("Missing approval");
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "yes" },
      }).ok,
    ).toBe(true);
  } finally {
    if (unrelated && saved)
      h.store
        .statement("UPDATE thread_state SET state=?,seq=? WHERE thread_id=?")
        .run(saved.state, saved.seq, unrelated);
    await h.close();
  }
});
