import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { HistoryService } from "./index.ts";

class WorkerBoundary extends EventEmitter {
  postMessage(value: unknown) {
    if (typeof value === "object" && value && "id" in value)
      queueMicrotask(() =>
        this.emit("message", {
          id: value.id,
          value: { type: "history.list", sessions: [], next: null },
        }),
      );
  }
  async terminate() {
    return 0;
  }
}

test("Node watch notifications do not crash history startup or consume pending replies", async () => {
  const worker = new WorkerBoundary();
  const service = new HistoryService(worker);
  expect(() => worker.emit("message", { "watch:import": ["file:///worker.ts"] })).not.toThrow();
  worker.emit("message", { id: 0, value: true });
  await service.ready;
  const listed = service.list({ type: "history.list", cwd: "/project" });
  expect(() => worker.emit("message", { "watch:import": ["file:///dependency.ts"] })).not.toThrow();
  expect(await listed).toMatchObject({ type: "history.list", sessions: [], next: null });
  await service.close();
});
