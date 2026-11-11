import { join } from "node:path";
import { expect, test } from "vitest";
import { fakeSpadeService } from "./__fixtures__/spade/fake-service.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { connectSpadeMcp, mcpStatus, spadeEnv, until } from "./spade-test-support.ts";

type Daemon = Awaited<ReturnType<typeof daemonFixture>>["daemon"];
const poll = { waiting: 50, ready: 200 };
const spadeGrants = (daemon: Daemon) =>
  daemon.externalMcp?.outside.grants.list().filter((grant) => grant.clientKind === "spade") ?? [];
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
    // Turned on: the binary is installed, the service registered and the grant made and listed,
    // while Spade itself hasn't started yet.
    await daemon.settings.set("spade.enabled", true, { kind: "global" });
    await until(() => spadeGrants(daemon).length === 1, "Spade's grant");
    expect(service.counts).toMatchObject({ binaryInstalls: 1, registrations: 1 });
    await until(() => daemon.spade?.status().state === "starting", "Spade to be starting");
    const [grant] = spadeGrants(daemon);
    expect(grant).toMatchObject({ name: "Spade", revokedAt: null, expiresAt: null });
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

    // A daemon restart keeps the grant: Spade keeps running and its token keeps working, without
    // being handed a new one.
    await spadeMcp.close();
    const pid = service.pid();
    daemon = await f.restart();
    await ready(daemon);
    expect(service.pid()).toBe(pid);
    expect(await mcpStatus(daemon.mcp?.url ?? "", token)).toBe(200);
    expect(await spadeEnv(daemon)).toMatchObject({ grant: token, handed: 1 });

    // The person revokes it: the token stops working at once and Spade is told to forget it.
    expect(daemon.externalMcp?.outside.revoke(grant?.id ?? "")).toBe(true);
    expect(await mcpStatus(daemon.mcp?.url ?? "", token)).toBe(401);
    await until(async () => (await spadeEnv(daemon)).grant === null, "Spade to forget its grant");

    // It stays revoked across a restart, until Spade is turned on again.
    daemon = await f.restart();
    await ready(daemon);
    expect(spadeGrants(daemon).filter((each) => each.revokedAt === null)).toEqual([]);
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
    expect(spadeGrants(daemon)).toMatchObject([{ revokedAt: expect.any(Number) }]);

    // On again: registered again, and the new Spade gets a new grant that works.
    await daemon.settings.set("spade.enabled", true, { kind: "global" });
    await ready(daemon);
    expect(service.pid()).not.toBe(pid);
    const second = await until(async () => (await spadeEnv(daemon)).grant, "a grant");
    expect(second).not.toBe(first);
    expect(await mcpStatus(daemon.mcp?.url ?? "", second)).toBe(200);
    expect(spadeGrants(daemon).filter((grant) => grant.revokedAt === null)).toHaveLength(1);
  } finally {
    await daemon.close();
    await service.close();
  }
}, 30_000);
