import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { ClientMessage, type MachinePathKind as PathKind } from "@ace/protocol";
import type { ConnectionState } from "./types.ts";
import { Multipath, type MachineRoute } from "./multipath.ts";
import { AgentId, ItemId, type EventPayload } from "@ace/protocol";
import { Faults, ManualScheduler, itemText, ready, sharedDaemon, when } from "./test-support.ts";

/*
 * Real sockets to a real daemon: each path is its own WebSocket to the daemon, so a switch
 * runs the daemon's own hello, subscriptions, replay and command receipts.
 */
const harness = sharedDaemon();

function route(faults: Faults, kind: PathKind, token: string): MachineRoute {
  return {
    path: { key: kind, kind },
    transport: () => faults.create(),
    credential: async () => token,
  };
}

/** Item ids are unique per daemon, so each test streams into its own message. */
function streamed(id: string) {
  const itemId = ItemId.parse(id);
  const agentId = AgentId.parse("agent");
  const created = {
    type: "item.created",
    item: {
      type: "message",
      id: itemId,
      agentId,
      role: "assistant",
      complete: false,
      createdAt: 1,
      parts: [{ type: "text", text: "" }],
      synthetic: false,
      raw: [],
    },
  } satisfies EventPayload;
  const delta = (append: string): EventPayload => ({
    type: "item.delta",
    itemId,
    agentId,
    field: "text",
    append,
  });
  return { itemId, created, delta };
}

async function twoPaths(lastWinner: PathKind, itemKey: string) {
  const { itemId, created, delta } = streamed(itemKey);
  const h = await harness();
  const token = (await readFile(h.daemon.tokenPath, "utf8")).trim();
  const lan = new Faults(h.daemon.url);
  const relay = new Faults(h.daemon.url);
  const scheduler = new ManualScheduler();
  const routes = [route(lan, "lan", token), route(relay, "relay", token)];
  const mismatched: string[] = [];
  const paths = new Multipath({
    mismatch: (path) => mismatched.push(path.key),
    routes: () => routes,
    scheduler,
    now: () => performance.now(),
    clock: () => performance.now(),
    lastWinner,
  });
  const race = paths.route();
  const { client } = h.make({ transport: race.transport, credential: race.credential, scheduler });
  client.usePaths(paths);
  const states: ConnectionState[] = [];
  client.connectionState().subscribe(() => states.push(client.state));
  await ready(client);
  const lease = client.thread(h.thread.id);
  const text = lease.store.select([`item:${itemId}`], (reader) => itemText(reader.item(itemId)));
  return {
    h,
    client,
    paths,
    scheduler,
    lan,
    relay,
    routes,
    states,
    text,
    mismatched,
    created,
    delta,
  };
}

/** What a path sent the daemon, parsed. */
const sent = (faults: Faults) => faults.sent.map((text) => ClientMessage.parse(JSON.parse(text)));

test("switching paths mid-stream loses and repeats no event, and re-asks an unanswered command by id", async () => {
  const { h, client, paths, scheduler, lan, relay, routes, text, created, delta } = await twoPaths(
    "relay",
    "switch-message",
  );
  try {
    expect(paths.active?.kind).toBe("relay");
    h.daemon.store.appendEvents(h.thread.id, [created, delta("a")]);
    await when(text, (value) => value === "a");

    // The old path never delivers this command's receipt: the daemon answers, the reply is lost.
    relay.incoming = (incoming, frame, deliver) => {
      if (incoming.type !== "commandResult") deliver(frame);
    };
    const archived = client.command({ type: "thread.archive", threadId: h.thread.id });
    await relay.wait((incoming) => incoming.type === "commandResult");
    const command = sent(relay).find((frame) => frame.type === "command");
    if (command?.type !== "command") throw new Error("No command went out");

    h.daemon.store.appendEvents(h.thread.id, [delta("b")]);
    const lanRoute = routes.find((entry) => entry.path.kind === "lan");
    if (!lanRoute) throw new Error("No LAN route");
    expect(await paths.switchTo(lanRoute)).toBe(true);
    expect(paths.active?.kind).toBe("lan");
    expect(client.state).toBe("ready");
    h.daemon.store.appendEvents(h.thread.id, [delta("c")]);
    await when(text, (value) => value === "abc");

    // The view caught up from its last applied seq on the new path.
    expect(
      sent(lan).some((frame) => frame.type === "subscribe" && frame.afterSeq !== undefined),
    ).toBe(true);
    // Draining: the old path is still open and the command still waits for its reply.
    expect(sent(lan).some((frame) => frame.type === "command")).toBe(false);
    scheduler.advance(2_000);
    await expect(archived).resolves.toMatchObject({ ok: true });
    const reasked = sent(lan).filter((frame) => frame.type === "command");
    expect(reasked.map((frame) => frame.type === "command" && frame.command.id)).toEqual([
      command.command.id,
    ]);

    h.daemon.store.appendEvents(h.thread.id, [delta("d")]);
    await when(text, (value) => value === "abcd");
    console.info(`path swap held the client for ${paths.lastSwapMs?.toFixed(3)} ms`);
    expect(paths.lastSwapMs).toBeLessThan(5);
  } finally {
    await h.cleanup();
  }
});

test("a dropped LAN path fails over to the warm relay without the client ever going offline", async () => {
  const { h, client, paths, lan, relay, states, text, created, delta } = await twoPaths(
    "lan",
    "failover-message",
  );
  try {
    expect(paths.active?.kind).toBe("lan");
    // The relay standby opens and is welcomed beside the LAN path.
    await relay.wait((incoming) => incoming.type === "welcome");
    h.daemon.store.appendEvents(h.thread.id, [created, delta("x")]);
    await when(text, (value) => value === "x");

    states.length = 0;
    const dropped = performance.now();
    lan.disconnect();
    expect(paths.active?.kind).toBe("relay");
    h.daemon.store.appendEvents(h.thread.id, [delta("y")]);
    await when(text, (value) => value === "xy");
    const failoverMs = performance.now() - dropped;
    console.info(`failover to the warm relay took ${failoverMs.toFixed(1)} ms to the next event`);

    expect(states.filter((state) => state !== "ready")).toEqual([]);
    expect(client.state).toBe("ready");
  } finally {
    await h.cleanup();
  }
});

test("a path that reaches another machine is dropped with a warning and never used", async () => {
  const { h, paths, lan, mismatched } = await twoPaths("relay", "mismatch-message");
  try {
    const token = (await readFile(h.daemon.tokenPath, "utf8")).trim();
    // This path's daemon names another identity in its welcome.
    lan.incoming = (incoming, frame, deliver) =>
      deliver(
        incoming.type === "welcome"
          ? frame.replace(/"hostId":"[^"]+"/, '"hostId":"another-machine"')
          : frame,
      );
    expect(await paths.switchTo(route(lan, "lan", token))).toBe(false);
    expect(mismatched).toEqual(["lan"]);
    expect(paths.active?.kind).toBe("relay");
  } finally {
    await h.cleanup();
  }
});
