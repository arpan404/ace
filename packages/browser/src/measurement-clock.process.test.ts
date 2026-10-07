import { expect, it } from "vitest";
import { InteractionMeasurement } from "@ace/protocol";
import { FakeHeadless, backendFixture } from "./backend-test-support.ts";
import { ref } from "./test-support.ts";

it("marker reply delay cannot count a pre-input frame as the response", async () => {
  let now = 0;
  const scheduled = new Set<{ at: number; work(): void }>();
  const clock = {
    now: () => now,
    set(delay: number, work: () => void) {
      const job = { at: now + delay, work };
      scheduled.add(job);
      return () => scheduled.delete(job);
    },
  };
  const advance = (to: number) => {
    now = to;
    for (const job of [...scheduled].toSorted((a, b) => a.at - b.at)) {
      if (job.at <= now && scheduled.delete(job)) job.work();
    }
  };
  const backend = new FakeHeadless();
  const dispatched = Promise.withResolvers<void>();
  const open = backend.open.bind(backend);
  backend.open = async (request) => {
    const session = await open(request);
    const click = session.click;
    session.click = async (x, y) => {
      await click(x, y);
      dispatched.resolve();
    };
    return session;
  };
  const f = await backendFixture({
    headlessBackend: backend,
    backendPreference: () => "headless",
    navigationClock: clock,
    id: () => "clock-test",
  });
  await f.open();
  const page = backend.pages[0];
  if (!page) throw new Error("Missing controlled browser");
  const snapshot = await f.service.execute("thread", { action: "snapshot" });
  const send = page.cdp.send;
  page.cdp.send = async (method, params) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (
      method === "Runtime.evaluate" &&
      typeof params?.["expression"] === "string" &&
      params["expression"].startsWith("console.timeStamp")
    ) {
      // Renderer marker ran at zero, but its reply reaches the host eighty ms later.
      now = 80;
      return { result: {} };
    }
    if (method === "Tracing.end") {
      page.events.emit("Tracing.dataCollected", {
        value: [
          {
            name: "TimeStamp",
            ts: 1_000_000,
            pid: 1,
            tid: 1,
            args: { data: { message: "ace-measure-clock-test", frame: "main" } },
          },
          {
            name: "SetLayerTreeId",
            ts: 1_000_000,
            pid: 1,
            args: { data: { frame: "main", layerTreeId: 1 } },
          },
          ...[10, 20, 30, 40, 50, 60, 70, 95, 110, 125, 140, 155, 170].map((at) => ({
            name: "DrawFrame",
            ts: 1_000_000 + at * 1000,
            pid: 1,
            args: { layerTreeId: 1 },
          })),
          ...Array.from({ length: 40 }, (_, index) => ({
            name: "BeginFrame",
            ts: 1_000_000 + index * 4000,
            pid: 1,
            args: { layerTreeId: 1 },
          })),
        ],
      });
      page.events.emit("Tracing.tracingComplete", { dataLossOccurred: false });
    }
    return send(method, params);
  };
  const pending = f.service.execute("thread", {
    action: "measure_interaction",
    interaction: { action: "click", ref: ref(snapshot, "Name") },
    observeMs: 200,
    filmstrip: false,
  });
  await dispatched.promise;
  advance(200);
  const measurement = InteractionMeasurement.parse(await pending);
  expect(measurement.latencyMs).toBe(15);
  expect(measurement.frames).toBe(6);
  expect(measurement.refreshHz).toBe(240);
});
