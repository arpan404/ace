import { afterEach, expect, it } from "vitest";
import { AgentId, InteractionId, ItemId } from "@ace/protocol";
import { startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { message } from "./payload-test-support.ts";
import { eventually, newClient, recordedSockets } from "./relay-nk-test-support.ts";
import { fixture } from "./socket-test-support.ts";

// Between an NK session's early events and its confirmation (ADR 0155, step 2), the thread can
// change: an approval raised, an item edited, another deleted. The early events mark nothing
// current: the client shows the thread as syncing until the subscription made at confirmation
// has caught up, whether it answers with a replay or a snapshot, and ends as an XX client does.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Waits for `check`; the test's timeout is the only limit. `_what` names it for the reader. */
const until = (check: () => boolean, _what: string) => eventually(check);

it.each([
  ["a replay", false],
  ["a snapshot (forced)", true],
] as const)(
  "changes made while the confirmation is in flight are shown before the thread reads current, when the subscription answers with %s",
  async (_name, forceSnapshot) => {
    const relay = await startRelay();
    cleanup.push(() => relay.close());
    const f = await fixture({
      relay: { url: relay.url, keys: keyPair() },
      // Past two events a thread's resume is answered with a snapshot.
      ...(forceSnapshot ? { replayLimit: 2 } : {}),
    });
    cleanup.push(() => f.close());
    const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
    const device = { id: paired.device.id, token: paired.token };
    const hostId = f.server.relayHostId ?? "";
    const append = (events: Parameters<typeof f.store.appendEvents>[1]) =>
      f.store.appendEvents(f.thread.id, events);

    const sockets = recordedSockets({ holdConfirm: true });
    const client = newClient(cleanup, relay.url, hostId, device, sockets.socket);
    await client.start();
    const lease = client.thread(f.thread.id);
    cleanup.push(() => lease.release());
    const store = lease.store;
    append([
      { type: "item.created", item: message("a", "first") },
      { type: "item.created", item: message("b", "second") },
    ]);
    await until(() => !store.syncing && store.item("b") !== undefined, "the open thread");
    // The XX welcome's next ticket, which the NK reconnect opens with.
    await client.ticketsHanded(1);

    // Away: one change missed, which the NK reconnect carries early.
    sockets.drop();
    append([{ type: "item.created", item: message("c", "missed") }]);
    await until(() => store.item("c") !== undefined, "the early events");
    expect(sockets.patterns().at(-1)).toBe("nk");
    expect(store.syncing).toBe(true);

    // While the confirmation is held: an approval, an edit, a deletion.
    const approval = InteractionId.parse("approval");
    append([
      {
        type: "interaction.opened",
        interaction: {
          id: approval,
          threadId: f.thread.id,
          agentId: AgentId.parse("root"),
          blocking: true,
          state: "pending",
          request: {
            kind: "approval",
            title: "Run the migration?",
            options: [
              { id: "yes", label: "Allow", kind: "allow_once" },
              { id: "no", label: "Deny", kind: "deny" },
            ],
          },
          createdAt: 1,
          raw: [],
        },
      },
      { type: "item.updated", item: message("a", "edited") },
      { type: "item.deleted", itemId: ItemId.parse("b") },
    ]);
    const has = () =>
      store.interaction(approval) !== undefined &&
      JSON.stringify(store.item("a")).includes("edited") &&
      store.item("b") === undefined;
    // Whenever the thread reads current, it holds all three.
    const shownCurrentWithout: number[] = [];
    const watch = setInterval(() => {
      if (!store.syncing && !has()) shownCurrentWithout.push(Date.now());
    }, 1);
    cleanup.push(() => clearInterval(watch));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.syncing).toBe(true);
    sockets.confirm();
    await until(() => !store.syncing, "the thread to read current");
    clearInterval(watch);
    expect(shownCurrentWithout).toEqual([]);
    expect(has()).toBe(true);

    // The same thread over XX, from scratch.
    const reference = newClient(cleanup, relay.url, hostId, device, recordedSockets().socket);
    await reference.start();
    const xx = reference.thread(f.thread.id);
    cleanup.push(() => xx.release());
    await until(() => !xx.store.syncing && xx.store.cursor === store.cursor, "the XX reference");
    const shape = (s: typeof store) => ({
      order: s.order,
      items: s.order.map((id) => s.item(id)),
      interactions: s.interactionIds().map((id) => s.interaction(id)),
      cursor: s.cursor,
    });
    expect(shape(store)).toEqual(shape(xx.store));
  },
  30_000,
);
