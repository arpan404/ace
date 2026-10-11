import { afterEach, expect, test } from "vitest";
import { CommandId } from "@ace/protocol";
import {
  fixture,
  cleanupRecovery,
  text,
  sends,
  dispatch,
  crashCopy,
  replaceProvider,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test.each([false, true])(
  "mailbox overload exposes unconfirmed delivery for guarded recovery, restart=%s",
  async (reopen) => {
    const frames = scriptFrames();
    const h = await fixture(
      [{ on: "send" }, { on: "send", frames: [frames.frame(start, end)] }],
      frames,
      { limits: { maxQueuedFrames: 2 } },
    );
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider");
    for (const append of ["accepted", " prefix", "rejected"])
      context.onFrame(
        frames.frame({ type: "item.delta", agent: "root", item: "answer", field: "text", append }),
      );
    await h.engine.flush();
    expect(context.signal.aborted).toBe(true);
    expect(h.engine.queue(id)).toMatchObject({
      paused: true,
      reason: "uncertain",
      messages: [{ state: "uncertain" }],
    });
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const copy = reopen ? await crashCopy(h) : { engine: h.engine, store: h.store };
    const { engine, store } = copy;
    expect(
      dispatch(
        store,
        engine,
        { type: "thread.resume", threadId: id, expectedRevision: engine.queue(id).revision },
        "resume-overload",
      ).error,
    ).toBe("uncertain_delivery");
    const old = engine.queue(id).messages[0];
    if (!old) throw new Error("Missing uncertain message");
    expect(
      dispatch(
        store,
        engine,
        {
          type: "queue.resend",
          threadId: id,
          expectedRevision: engine.queue(id).revision,
          messageId: CommandId.parse(old.id),
        },
        "resend-overload",
      ).ok,
    ).toBe(true);
    await engine.flush();
    expect([...sends(h.adapter), ...sends(replacement)].map((command) => command.input)).toEqual([
      text("first"),
      text("first"),
    ]);
    expect(store.getThread(id)?.status.state).toBe("done");
    expect(engine.queue(id).messages).toEqual([]);
    expect(h.contexts).toHaveLength(2);
  },
);
