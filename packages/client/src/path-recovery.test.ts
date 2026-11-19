import { expect, test } from "vitest";
import { connected, pass, settle, type Path } from "./path-switch.fixture.ts";

/*
 * How a machine's connection recovers across its paths (ADR 0114): a path reaching another
 * daemon, a standby opening that outlives its path, a grant closing a standby, and each
 * socket's grant refresh answered on whatever path it was sent.
 */

const otherDaemon = "6b1d2f9e-0d3a-4c51-9a8e-2b7f4c1e0a99";

test("a pinned client whose LAN address now reaches another daemon drops that path and connects over the relay", async () => {
  const { clock, client, multipath, mismatched } = await connected("lan", ["lan", "relay"], {
    expectedHostId: "30f6c4b7-ee27-4793-8c80-7613f816a314",
    prepare: (each) => {
      if (each.kind === "lan") each.welcomes = otherDaemon;
    },
    ready: false,
  });
  for (let round = 0; round < 8 && client.state !== "ready"; round++) {
    clock.advance(1_000);
    await settle();
  }
  expect(client.state).toBe("ready");
  expect(multipath.active?.kind).toBe("relay");
  expect(mismatched).toEqual(["lan"]);
  expect(client.error).toBeUndefined();
});

test("a standby still opening when the connection moved to a better path is replaced by one for the new path", async () => {
  const { clock, client, multipath, path, route } = await connected(
    "tailscale",
    ["lan", "tailscale", "relay"],
    {
      // The relay is slow: the standby for Tailscale is still opening when the LAN is taken.
      prepare: (each) => {
        if (each.kind === "relay") each.held = true;
      },
    },
  );
  expect(await multipath.switchTo(route("lan"))).toBe(true);
  path("relay").release();
  await settle();
  // The Tailscale path drains for 2 s after the switch; then the LAN is all there is.
  await pass(clock, 2_000);
  const standby = path("relay").last;
  expect(standby.closed).toBe(false);
  expect(standby.sent.map((message) => message.type)).toEqual(["hello", "presence.update"]);

  // It is a working standby for the LAN: the LAN dropping fails over onto it at once.
  path("lan").last.drop();
  await settle();
  expect(multipath.active?.kind).toBe("relay");
  expect(client.state).toBe("ready");
});

test("a standby closed because its grant ran out is replaced at once, not rested", async () => {
  const { clock, path } = await connected("lan", ["lan", "relay"]);
  await settle();
  const relay = path("relay");
  relay.last.drop(4014);
  // No time passes: a failed relay would rest a second before the next try.
  clock.advance(0);
  await settle();
  expect(relay.sockets).toHaveLength(2);
  expect(relay.last.closed).toBe(false);
});

/** Every path welcomes with a 30 s grant and answers each refresh with `answer`. */
const granted =
  (answer: (kind: string) => Record<string, unknown>) =>
  (each: Path): void => {
    each.grantTtlMs = 30_000;
    each.refresh = () => answer(each.kind);
  };
const refreshes = (path: Path) =>
  path.last.sent.filter((message) => message.type === "account.grant.refresh").length;

test("a standby's grant refresh is answered on the standby and timed from that answer", async () => {
  const { clock, path } = await connected("lan", ["lan", "relay"], {
    grant: async () => "grant",
    prepare: granted(() => ({ ok: true, grantTtlMs: 100_000 })),
  });
  await pass(clock, 50_000);
  expect(refreshes(path("relay"))).toBe(1);
  // Answered: no retry 10 s later; the next one comes halfway through the new 100 s.
  await pass(clock, 10_000);
  expect(refreshes(path("relay"))).toBe(1);
  await pass(clock, 40_000);
  expect(refreshes(path("relay"))).toBe(2);
});

test("a refresh refused for the machine code reconnects instead of failing over, so the code is asked for", async () => {
  const { clock, client, multipath, path } = await connected("lan", ["lan", "relay"], {
    grant: async () => "grant",
    prepare: granted(() => ({ ok: false, code: "machine_code_required", message: "Enter it" })),
  });
  await pass(clock, 15_000);
  expect(path("lan").sockets[0]?.closed).toBe(true);
  expect(client.state).not.toBe("ready");
  expect(multipath.active).toBeUndefined();
  expect(client.connectionInfo().getSnapshot().lastClose).toMatchObject({ code: 4012 });
});
