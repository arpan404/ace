import { ClientError, type ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { schedule as defaultSchedule, type Schedule } from "../schedule.ts";
import type { TerminalEnd } from "./closing.ts";

interface DaemonEnds {
  pending: Map<string, TerminalEnd>;
  active: Delivery | undefined;
  reading: boolean;
  retry: (() => void) | undefined;
  delay: number;
}
interface Delivery {
  client: ClientApi;
  references: number;
  hostId: string | undefined;
  pending: Map<string, TerminalEnd>;
  identity: ReturnType<typeof Promise.withResolvers<string>>;
  identifying: boolean;
  controller: AbortController;
  stops: (() => void)[];
  retry: (() => void) | undefined;
  delay: number;
}
const keyOf = (end: TerminalEnd) => `${end.threadId}\u0000${end.terminalId}`;

/** Close delivery is scoped to authenticated host identity, never to an App or a lazy chunk. */
export function createTerminalEndDelivery(schedule: Schedule) {
  const daemons = new Map<string, DaemonEnds>();
  const clients = new WeakMap<ClientApi, Delivery>();
  const groupOf = (hostId: string) => {
    let group = daemons.get(hostId);
    if (!group) {
      group = {
        pending: new Map(),
        active: undefined,
        reading: false,
        retry: undefined,
        delay: 250,
      };
      daemons.set(hostId, group);
    }
    return group;
  };
  const usable = (delivery: Delivery) =>
    delivery.references > 0 && delivery.client.state === "ready";

  // A generic service failure cannot establish absence. A successful scoped list can.
  const absent = async (delivery: Delivery, end: TerminalEnd): Promise<boolean> => {
    const reply = await delivery.client.request(
      {
        type: "terminal.request",
        operation: { op: "list", threadId: ThreadId.parse(end.threadId) },
      },
      { signal: delivery.controller.signal },
    );
    return (
      reply.ok &&
      reply.terminals !== undefined &&
      !reply.terminals.some((entry) => entry.id === end.terminalId)
    );
  };
  const close = async (delivery: Delivery, end: TerminalEnd): Promise<boolean> => {
    try {
      const reply = await delivery.client.request(
        {
          type: "terminal.request",
          operation: {
            op: "close",
            threadId: ThreadId.parse(end.threadId),
            terminalId: end.terminalId,
          },
        },
        { signal: delivery.controller.signal },
      );
      if (reply.ok || reply.error === "terminal_not_found") return true;
    } catch (error) {
      // Limits, timeouts and disconnects are transient; keep the intent without another read.
      if (!(error instanceof ClientError) || error.code !== "daemon") return false;
    }
    return absent(delivery, end);
  };
  const pump = (group: DaemonEnds): void => {
    const delivery = group.active;
    const first = group.pending.entries().next().value;
    if (!delivery || !usable(delivery) || !first || group.reading || group.retry) return;
    const [key, end] = first;
    group.reading = true;
    void close(delivery, end)
      .catch(() => false)
      .then((acknowledged) => {
        group.reading = false;
        if (acknowledged) {
          group.pending.delete(key);
          group.delay = 250;
          pump(group);
        } else {
          // A refused or unavailable handle must not hold later closes behind it forever.
          group.pending.delete(key);
          group.pending.set(key, end);
          if (group.active !== delivery) pump(group);
          else if (usable(delivery)) {
            // One request at a time, with capped backoff when other reads occupy the budget.
            group.retry = schedule(() => {
              group.retry = undefined;
              pump(group);
            }, group.delay);
            group.delay = Math.min(8000, group.delay * 2);
          }
        }
      });
  };
  const identify = (delivery: Delivery, hostId: string) => {
    if (!delivery.references || (delivery.hostId && delivery.hostId !== hostId)) return;
    delivery.hostId = hostId;
    delivery.retry?.();
    delivery.retry = undefined;
    const group = groupOf(hostId);
    for (const [key, end] of delivery.pending) group.pending.set(key, end);
    delivery.pending.clear();
    group.active = delivery;
    group.retry?.();
    group.retry = undefined;
    delivery.identity.resolve(hostId);
    pump(group);
  };
  const follow = (delivery: Delivery): void => {
    if (!usable(delivery)) {
      delivery.retry?.();
      delivery.retry = undefined;
      if (delivery.hostId) {
        const group = groupOf(delivery.hostId);
        if (group.active === delivery) {
          group.retry?.();
          group.retry = undefined;
        }
      }
      return;
    }
    if (delivery.hostId) {
      identify(delivery, delivery.hostId);
      return;
    }
    // Worker clients don't forward welcome; read authenticated identity before exposing tabs.
    if (delivery.identifying || delivery.retry) return;
    delivery.identifying = true;
    void delivery.client
      .request({ type: "host.identity" }, { signal: delivery.controller.signal })
      .then(
        (reply) => {
          delivery.identifying = false;
          identify(delivery, reply.identity.hostId);
        },
        () => {
          delivery.identifying = false;
          if (!usable(delivery)) return;
          delivery.retry = schedule(() => {
            delivery.retry = undefined;
            follow(delivery);
          }, delivery.delay);
          delivery.delay = Math.min(8000, delivery.delay * 2);
        },
      );
  };
  const bind = (client: ClientApi) => {
    let delivery = clients.get(client);
    if (!delivery) {
      delivery = {
        client,
        references: 0,
        hostId: undefined,
        pending: new Map(),
        identity: Promise.withResolvers<string>(),
        identifying: false,
        controller: new AbortController(),
        stops: [],
        retry: undefined,
        delay: 250,
      };
      clients.set(client, delivery);
    }
    const current = delivery;
    if (current.references++ === 0) {
      current.controller = new AbortController();
      current.stops = [
        client.onMessage((message) => {
          if (message.type === "welcome") identify(current, message.hostId);
        }),
        client.connectionState().subscribe(() => follow(current)),
      ];
      follow(current);
    }
    let released = false;
    return {
      identified: current.identity.promise,
      release() {
        if (released) return;
        released = true;
        if (--current.references) return;
        for (const stop of current.stops) stop();
        current.stops = [];
        current.controller.abort();
        current.retry?.();
        current.retry = undefined;
        if (current.hostId) {
          const group = groupOf(current.hostId);
          if (group.active === current) {
            group.active = undefined;
            group.retry?.();
            group.retry = undefined;
          }
          if (!group.pending.size && !group.active && !group.reading)
            daemons.delete(current.hostId);
        }
      },
    };
  };
  return {
    bind,
    end(client: ClientApi, end: TerminalEnd) {
      const delivery = clients.get(client);
      if (!delivery?.references) throw new Error("terminal_close_owner_missing");
      if (!delivery.hostId) {
        delivery.pending.set(keyOf(end), { ...end });
        return;
      }
      const group = groupOf(delivery.hostId);
      if (!group.pending.has(keyOf(end))) group.pending.set(keyOf(end), { ...end });
      pump(group);
    },
  };
}

// The page owns this delivery boundary. App retirement releases readers, not unacknowledged closes.
const terminalEndDelivery = createTerminalEndDelivery(defaultSchedule);
export const bindTerminalEndDelivery = terminalEndDelivery.bind;
export const endPanelTerminal = terminalEndDelivery.end;
