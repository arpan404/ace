import { expect, test } from "vitest";
import type { ExecutionInput } from "./index.ts";
import { definition, harness } from "./service-test-support.ts";

const subject = (key: string) => ({ key, variables: { subject: key } });

/** An executor whose stop never gets through, as when the daemon dies right after a pause. */
function unreachableStop(h: ReturnType<typeof harness>) {
  const calls: ExecutionInput[] = [];
  h.deps.executor.interrupt = (input) => {
    calls.push(input);
    return Promise.reject(new Error("Executor unavailable"));
  };
  return calls;
}

test("a pause whose stop never reached the executor stops the run after a restart, unsent", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", subject("first"));
  const stops = unreachableStop(h);
  h.service.setEnabled("triage", false);
  await flush();
  expect(stops).toHaveLength(1);
  expect(h.service.inbox().runs[0]?.status).toBe("running");
  // The daemon restarts. Nothing of the run reached its thread, so it is never sent now.
  h.restart();
  await flush();
  expect(stops.map((input) => input.idempotencyKey)).toEqual([first.id, first.id]);
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs[0]).toMatchObject({
    status: "failed",
    result: "Stopped before it started.",
  });
});

test("a stop that fails to reach the executor is tried again until it gets through", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", subject("first"));
  const stops = unreachableStop(h);
  h.service.setEnabled("triage", false);
  await flush();
  expect(stops).toHaveLength(1);
  h.deps.executor.interrupt = (input) => {
    stops.push(input);
    h.completions[0]?.resolve({
      threadId: "thread-0",
      status: "failed",
      result: "Stopped before it finished.",
    });
    return Promise.resolve();
  };
  await h.timer.fire();
  await flush();
  expect(stops).toHaveLength(2);
  expect(h.service.inbox().runs[0]).toMatchObject({
    status: "failed",
    result: "Stopped before it finished.",
  });
  // A finished run's cancellation is done with: a later restart sends no stop.
  h.restart();
  await flush();
  expect(stops).toHaveLength(2);
});

test("deleting an automation keeps its run's cancellation until the run has stopped", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", subject("first"));
  const stops = unreachableStop(h);
  h.service.remove("triage");
  await flush();
  h.restart();
  await flush();
  expect(stops).toHaveLength(2);
});

/** Let promise callbacks run; the runs here stay open, so `settled` would wait on them. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
