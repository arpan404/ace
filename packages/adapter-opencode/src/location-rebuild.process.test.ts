import { expect, it } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";

/*
 * OpenCode's location.shutdown closes a location's services, its shells included, and rebuilds
 * them on the next request. A shell killed that way never reports shell.exited, so ace verifies
 * every shell it holds against the rebuilt location instead of waiting on it forever.
 */

async function idleWithShell() {
  const h = await setup();
  const shell = {
    id: "dev-server",
    status: "running",
    cwd: "/one",
    metadata: { sessionID: h.session.nativeSessionId },
  };
  await h.control("/test/state", { shells: [shell] });
  await h.publish("session.execution.started");
  await h.publish("shell.created", { info: shell });
  await h.publish("session.execution.succeeded");
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  return h;
}

it("a background shell killed by a location rebuild ends its task and the thread settles", async () => {
  const h = await idleWithShell();
  await h.control("/test/state", { shells: [] });
  const recovered = h.recovered();
  await h.control("/test/events", [{ type: "location.shutdown", directory: "/one", data: {} }]);
  await recovered;
  expect(Object.values(h.projection.view.backgroundTasks).map((task) => task.status)).toEqual([
    "stopped",
  ]);
  expect(h.projection.view.thread.status.state).toBe("done");
});

it("a background shell that survives a location rebuild keeps the thread waiting", async () => {
  const h = await idleWithShell();
  const recovered = h.recovered();
  await h.control("/test/events", [{ type: "location.shutdown", directory: "/one", data: {} }]);
  await recovered;
  expect(Object.values(h.projection.view.backgroundTasks).map((task) => task.status)).toEqual([
    "running",
  ]);
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
});

it("stopping a tree whose turns ended removes its running shells instead of failing", async () => {
  const h = await idleWithShell();
  await h.control("/test/state", { fault: { noopInterrupt: true } });
  await h.session.interrupt({ cascade: true });
  const removals = array(await h.control("/test/requests"))
    .map(object)
    .filter((request) => request.method === "DELETE");
  expect(removals.map((request) => request.path)).toEqual(["/api/shell/dev-server"]);
});
