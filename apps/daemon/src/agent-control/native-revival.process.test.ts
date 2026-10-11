import { expect, test } from "vitest";
import { setup, wakes } from "./test-support.ts";

test("an unsolicited child run restores concurrency, survives owner restart, and returns its fresh result once", async () => {
  const f = setup({ maxConcurrent: 1 });
  const parent = await f.parent();
  const child = f.delegate(parent, "child");
  await f.engine.flush();
  await f.complete(child.childId, "First answer");
  f.clock.advance(f.clock.now() + 100);
  await f.engine.flush();
  await f.emit(child.childId, {
    type: "turn.started",
    agent: "root",
    trigger: "background_completion",
    nativeTurnId: "native-revival",
  });
  expect(f.store.getThread(parent.threadId)?.status.state).toBe("working");
  expect(() => f.delegate(parent, "while-revived")).toThrow(/concurrency/);
  // Repeated provider observations and service recreation must not reserve another generation.
  await f.emit(child.childId, { type: "activity", agent: "root", activity: "thinking" });
  f.restartOwner();
  await f.complete(child.childId, "Second answer");
  f.clock.advance(f.clock.now() + 100);
  await f.engine.flush();
  expect(await f.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "completed",
    result: "Second answer",
  });
  expect(wakes(f.events, parent.threadId)).toHaveLength(2);
  f.restartOwner();
  f.clock.advance(f.clock.now() + 100);
  await f.engine.flush();
  expect(wakes(f.events, parent.threadId)).toHaveLength(2);
  expect(
    f.inputs.get(parent.threadId)?.filter((text) => text.includes("Second answer")),
  ).toHaveLength(1);
});

test("cascade Stop interrupts a child revived by its provider and keeps late results suppressed", async () => {
  const f = setup();
  const parent = await f.parent();
  const child = f.delegate(parent, "child", true);
  await f.engine.flush();
  await f.complete(child.childId, "First answer");
  await f.service.wait(parent, child.childId, new AbortController().signal);
  await f.emit(child.childId, {
    type: "turn.started",
    agent: "root",
    trigger: "background_completion",
  });
  expect(
    f.service.command("stop-revival", {
      type: "thread.interrupt",
      threadId: parent.threadId,
      cascade: true,
    }).ok,
  ).toBe(true);
  await f.engine.flush();
  expect(f.store.getThread(child.childId)?.status.state).toBe("done");
  expect(await f.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    outcome: "cancelled",
  });
  // A provider cannot clear the durable Stop by spontaneously starting again.
  f.restartOwner();
  await f.emit(child.childId, {
    type: "turn.started",
    agent: "root",
    trigger: "background_completion",
  });
  await f.engine.flush();
  expect(f.store.getThread(child.childId)?.status.state).toBe("done");
  expect(() => f.delegate(f.caller(child.childId), "after-stop")).toThrow(/cancelled/);
  f.clock.advance(f.clock.now() + 100);
  await f.engine.flush();
  expect(wakes(f.events, parent.threadId)).toHaveLength(0);
});
