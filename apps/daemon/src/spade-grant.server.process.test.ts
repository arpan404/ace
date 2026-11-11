import { join } from "node:path";
import { expect, test } from "vitest";
import { fakeSpadeService } from "./__fixtures__/spade/fake-service.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import {
  adminSocket,
  connectSpadeMcp,
  mcpStatus,
  OlderOutsideResult,
  spadeEnv,
  until,
} from "./spade-test-support.ts";

type Daemon = Awaited<ReturnType<typeof daemonFixture>>["daemon"];
const poll = { waiting: 50, ready: 200 };
/** Spade's grant as `spade.status` shows it. */
const grantOf = (daemon: Daemon) => daemon.spade?.status().grant;
const ready = (daemon: Daemon) =>
  until(
    () => daemon.spade?.status().state === "ready",
    () => `Spade to be ready (${JSON.stringify(daemon.spade?.status())})`,
  );

test("Spade's grant reaches Spade when it appears, acts only as its host thread, survives a daemon restart and stops working once revoked", async () => {
  let home = "";
  const service = fakeSpadeService(() => home, { held: true });
  const f = await daemonFixture(undefined, { spade: { service: service.control, pollMs: poll } });
  home = join(f.h.home, "daemon");
  let daemon = f.daemon;
  const closing: (() => Promise<unknown>)[] = [];
  try {
    // Turned on: the binary is installed, the service registered and the grant made and shown,
    // while Spade itself hasn't started yet.
    await daemon.settings.set("spade.enabled", true, { kind: "global" });
    await until(() => grantOf(daemon)?.state === "present", "Spade's grant");
    expect(service.counts).toMatchObject({ binaryInstalls: 1, registrations: 1 });
    await until(() => daemon.spade?.status().state === "starting", "Spade to be starting");
    expect(grantOf(daemon)).toEqual({ state: "present", lastUsedAt: null });
    const hostId = daemon.spade?.status().thread?.id;
    expect(hostId && daemon.store.getThread(hostId)?.host).toBe("spade");

    // Spade's server.json appears later: it is handed the grant then.
    service.release();
    await ready(daemon);
    const token = await until(async () => (await spadeEnv(daemon)).grant, "Spade's grant");
    const mcpUrl = daemon.mcp?.url ?? "";

    // The grant is the host thread's lease: the agent tool set, with nothing that waits on the
    // person inside the hidden thread.
    const spadeMcp = await connectSpadeMcp(mcpUrl, token);
    closing.push(() => spadeMcp.close());
    const names = (await spadeMcp.listTools()).tools.map((tool) => tool.name);
    for (const tool of ["delegate", "wait", "agents_status", "thread_start", "notify"])
      expect(names).toContain(tool);
    expect(names).not.toContain("ask");
    expect(names).not.toContain("browser_request_help");
    const asked = await spadeMcp.callTool({ name: "ask", arguments: { question: "?" } }).then(
      (result) => result.isError === true,
      () => true,
    );
    expect(asked).toBe(true);
    // ... and nothing else: the outside clients' endpoint refuses it.
    const outsideUrl = daemon.externalMcp?.url ?? "";
    expect(await mcpStatus(outsideUrl, token)).toBe(401);

    // Used, it says when; and the outside clients' list, as an app from before Spade's grant
    // reads it, holds no sign of it.
    expect(grantOf(daemon)?.lastUsedAt).toEqual(expect.any(Number));
    const desktop = await adminSocket(daemon);
    closing.push(() => desktop.close());
    const listed = OlderOutsideResult.parse(
      await desktop.ask({
        type: "outside.request",
        requestId: "grants",
        operation: { op: "grants" },
      }),
    );
    expect(listed.result.grants).toEqual([]);

    // A daemon restart keeps the grant: Spade keeps running and its token keeps working, without
    // being handed a new one.
    await spadeMcp.close();
    const pid = service.pid();
    daemon = await f.restart();
    await ready(daemon);
    expect(service.pid()).toBe(pid);
    expect(await mcpStatus(daemon.mcp?.url ?? "", token)).toBe(200);
    expect(await spadeEnv(daemon)).toMatchObject({ grant: token, handed: 1 });

    // The person revokes it from Spade's settings: the token stops working at once and Spade is
    // told to forget it.
    const settings = await adminSocket(daemon);
    closing.push(() => settings.close());
    expect(await settings.ask({ type: "spade.grant.revoke", requestId: "revoke" })).toMatchObject({
      type: "spade.grant.revoke.result",
      revoked: true,
    });
    expect(grantOf(daemon)?.state).toBe("revoked");
    expect(await mcpStatus(daemon.mcp?.url ?? "", token)).toBe(401);
    await until(async () => (await spadeEnv(daemon)).grant === null, "Spade to forget its grant");

    // It stays revoked across a restart, until Spade is turned on again.
    daemon = await f.restart();
    await ready(daemon);
    expect(grantOf(daemon)?.state).toBe("revoked");
    expect((await spadeEnv(daemon)).grant).toBeNull();
  } finally {
    for (const close of closing) await close().catch(() => {});
    await daemon.close();
    await service.close();
  }
}, 30_000);

test("turning Spade off retires its grant and removes its service; turning it on makes a new grant", async () => {
  let home = "";
  const service = fakeSpadeService(() => home);
  const f = await daemonFixture(undefined, { spade: { service: service.control, pollMs: poll } });
  home = join(f.h.home, "daemon");
  const daemon = f.daemon;
  try {
    await daemon.settings.set("spade.enabled", true, { kind: "global" });
    await ready(daemon);
    const first = await until(async () => (await spadeEnv(daemon)).grant, "a grant");
    const pid = service.pid();

    await daemon.settings.set("spade.enabled", false, { kind: "global" });
    await until(() => !service.registered(), "the service to be removed");
    await until(() => daemon.spade?.status().state === "off", "Spade to be off");
    expect(service.pid()).toBeUndefined();
    expect(await mcpStatus(daemon.mcp?.url ?? "", first)).toBe(401);
    expect(grantOf(daemon)?.state).toBe("revoked");

    // On again: registered again, and the new Spade gets a new grant that works.
    await daemon.settings.set("spade.enabled", true, { kind: "global" });
    await ready(daemon);
    expect(service.pid()).not.toBe(pid);
    const second = await until(async () => (await spadeEnv(daemon)).grant, "a grant");
    expect(second).not.toBe(first);
    expect(await mcpStatus(daemon.mcp?.url ?? "", second)).toBe(200);
    expect(grantOf(daemon)?.state).toBe("present");
  } finally {
    await daemon.close();
    await service.close();
  }
}, 30_000);
