import { expect, test } from "vitest";
import { setup } from "./publication-project-test-support.ts";
import { projectServer, until } from "./projects-test-support.ts";

test("reconnecting can inspect and stop an owned publication that is still running", async () => {
  const f = await setup({ hold: true });
  const server = await projectServer(f, { sourceControl: f.cli.source });
  try {
    const pending = f.publish();
    await f.cli.created();
    expect(await f.projects.publicationState(f.id, "other-device", () => true)).toMatchObject({ running: true, canStop: false });
    const first = await server.connect();
    first.send({ type: "repositories.request", requestId: "before-reconnect", operation: { op: "publication", workspaceId: f.id } });
    expect(await until(first, (reply) => reply.type === "repositories.result" && reply.requestId === "before-reconnect")).toMatchObject({ result: { kind: "publication", running: true, canStop: true } });
    await first.close();
    const next = await server.connect();
    next.send({ type: "repositories.request", requestId: "after-reconnect", operation: { op: "publication", workspaceId: f.id } });
    expect(await until(next, (reply) => reply.type === "repositories.result" && reply.requestId === "after-reconnect")).toMatchObject({ result: { running: true, canStop: true } });
    next.send({ type: "repositories.request", requestId: "stop-reconnected", operation: { op: "publication.cancel", workspaceId: f.id } });
    await until(next, (reply) => reply.type === "repositories.result" && reply.requestId === "stop-reconnected");
    expect(await pending).toMatchObject({ ok: false, error: "publication_cancelled" });
    next.send({ type: "repositories.request", requestId: "settled", operation: { op: "publication", workspaceId: f.id } });
    expect(await until(next, (reply) => reply.type === "repositories.result" && reply.requestId === "settled")).toMatchObject({ result: { running: false, canStop: false } });
    expect((await f.cli.state()).creates).toBe(1);
    expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe("");
  } finally { await server.close(); await f.cleanup(); }
});
