import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { GuardedHeadless } from "@ace/browser/testing";
import { originFixture } from "./browser-origin-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function redirectServer() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let destination = "";
  const server = createServer((request, response) => {
    if (request.url !== "/slow") return response.end("ok");
    entered.resolve();
    void release.promise.then(() => {
      response.writeHead(302, { location: destination });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  destination = `http://destination.test:${address.port}/final`;
  cleanups.push(async () => {
    release.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const backend = new GuardedHeadless(async (url) => {
    const local = new URL(url);
    local.hostname = "127.0.0.1";
    const response = await fetch(local, { redirect: "manual" });
    await response.text();
    return response.headers.get("location") ?? undefined;
  });
  return { backend, entered: entered.promise, release: release.resolve, origin, destination };
}
it("taking control during an agent's slow redirect never grants the destination as human consent", async () => {
  const server = await redirectServer();
  const f = await originFixture("ask", undefined, server.backend);
  const navigation = f.navigation(`${server.origin}/slow`);
  await server.entered;
  const owner = await f.client();
  await owner.request({ type: "browser.takeover", requestId: "take", threadId: f.thread.id });
  const opened = f.opened();
  server.release();
  const interaction = await opened;
  expect(interaction.request).toMatchObject({
    kind: "approval",
    target: { input: { origin: new URL(server.destination).origin } },
  });
  expect(f.browser.originsList(f.thread.id)).toEqual([]);
  expect(f.resolve(interaction, "allow_once").ok).toBe(true);
  await navigation;
  expect(f.browser.originsList(f.thread.id)).toEqual([]);
  expect(
    await owner.request({ type: "browser.handback", requestId: "back", threadId: f.thread.id }),
  ).toMatchObject({ ok: true });
  const nextApproval = f.opened();
  const nextNavigation = expect(f.navigation(server.destination)).rejects.toMatchObject({
    blocked: { origin: new URL(server.destination).origin, reason: "denied" },
  });
  expect(f.resolve(await nextApproval, "deny").ok).toBe(true);
  await nextNavigation;
});
it("handback before a late redirect approval cannot retain consent from the previous agent lease", async () => {
  const server = await redirectServer();
  const f = await originFixture("ask", undefined, server.backend);
  const navigation = f.navigation(`${server.origin}/slow`);
  await server.entered;
  f.browser.takeover(f.thread.id, "owner");
  const opened = f.opened();
  server.release();
  const interaction = await opened;
  f.browser.handback(f.thread.id, "owner");
  expect(f.resolve(interaction, "allow_once").ok).toBe(true);
  await navigation;
  expect(f.browser.originsList(f.thread.id)).toEqual([]);
});
it("denying an agent redirect returns its typed block and publishes the same blocked state to the wire viewer", async () => {
  const server = await redirectServer();
  const f = await originFixture("ask", undefined, server.backend);
  const viewer = await f.client();
  await viewer.request({
    type: "browser.subscribe",
    requestId: "subscribe",
    threadId: f.thread.id,
  });
  const opened = f.opened();
  const failure = expect(f.navigation(`${server.origin}/slow`)).rejects.toMatchObject({
    blocked: { origin: new URL(server.destination).origin, reason: "denied" },
  });
  await server.entered;
  server.release();
  const interaction = await opened;
  expect(f.resolve(interaction, "deny").ok).toBe(true);
  await failure;
  expect(
    await viewer.next(
      (message) => message.type === "browser.state" && message.state.blocked?.reason === "denied",
    ),
  ).toMatchObject({
    state: { blocked: { origin: new URL(server.destination).origin, reason: "denied" } },
  });
});
