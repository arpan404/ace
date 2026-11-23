import type { ClientCore } from "@ace/client";
import { UsageQuery } from "@ace/protocol";
import {
  accountView,
  RailPins,
  knownTimeZone,
  railUsage,
  usageDay,
  usageLimits,
  type AccountView,
} from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { host } from "./host.ts";
import type { InboxClock } from "./inbox-rows.ts";

const minute = 60_000;

/**
 * The desktop rail's session bars, followed on this machine's connection. The phone's own choice
 * of accounts (`choose`, the web's pins) picks and orders them; with none, the accounts used most.
 * `usage.choices` lists every account with a reading, for the picker.
 */
export function followUsageBars(owner: ClientCore, sink: PatchSink, clock: InboxClock) {
  const connection = owner.connectionState();
  const socket = owner.connectionGeneration();
  let accounts: AccountView[] = [];
  let used: ReadonlyMap<string, number> | undefined;
  let sent = JSON.stringify({ bars: [], choices: [] });
  let pins: RailPins = [];
  let cancelTick: (() => void) | undefined;
  let active: AbortController | undefined;
  let loadingAccounts = false;
  let zone: { timeZone: string | undefined } | undefined;
  let ranked: string | undefined;

  const publish = () => {
    const now = clock.now();
    const limits = usageLimits(
      accounts.map((account) => ({ account, environment: "This machine" })),
      Math.floor(now / minute) * minute,
    );
    const { bars, choices } = railUsage(limits, used, "session", pins);
    const encoded = JSON.stringify({ bars, choices });
    if (sent === encoded) return;
    sent = encoded;
    sink.put("usage.bars", () => ({ type: "usage.bars", value: bars, choices }));
  };

  const refresh = async (readAccounts: boolean) => {
    if (connection.getSnapshot() !== "ready") return;
    active?.abort();
    const request = new AbortController();
    active = request;
    loadingAccounts = readAccounts;
    const options = { signal: request.signal, timeoutMs: 15_000 };
    try {
      if (readAccounts) {
        const reply = await owner.request(
          { type: "accounts.list", requestId: host.uuid() },
          options,
        );
        if (request.signal.aborted) return;
        accounts = reply.accounts.map(accountView);
        loadingAccounts = false;
      }
      if (!accounts.length) return;
      const summary = (query: UsageQuery) =>
        owner.request({ type: "usage.summary", requestId: host.uuid(), query }, options);
      if (!zone) {
        const reply = await summary(
          UsageQuery.parse({ from: "2026-01-01", to: "2026-01-01", limit: 1 }),
        );
        if (request.signal.aborted) return;
        zone = { timeZone: knownTimeZone(reply.result.timezone) };
      }
      const now = clock.now();
      const from = usageDay(now, zone.timeZone, 6);
      const to = usageDay(now, zone.timeZone);
      const observedAt = Math.max(
        0,
        ...accounts.flatMap((account) => [
          account.quota.observedAt,
          ...account.windows.map((window) => window.observedAt ?? 0),
        ]),
      );
      const key = `${to}:${observedAt}`;
      if (ranked === key) return;
      const reply = await summary(UsageQuery.parse({ from, to, groupBy: ["account"], limit: 100 }));
      if (request.signal.aborted) return;
      ranked = key;
      used = new Map(
        reply.result.rows.map((row) => [
          row.dimensions.account ?? "",
          row.totals.inputTokens + row.totals.outputTokens,
        ]),
      );
    } catch {
      // Account readings can still draw bars if this daemon cannot rank them.
    } finally {
      if (!request.signal.aborted) {
        loadingAccounts = false;
        publish();
        if (!cancelTick) tick();
      }
    }
  };

  const tick = () => {
    cancelTick?.();
    cancelTick = undefined;
    if (!accounts.length || connection.getSnapshot() !== "ready") return;
    cancelTick = clock.set(minute - (clock.now() % minute), () => {
      publish();
      // Re-rank across midnight as the desktop rail does. The same day's reads are cached.
      if (zone && ranked && !ranked.startsWith(usageDay(clock.now(), zone.timeZone))) {
        void refresh(false);
      }
      tick();
    });
  };

  const reconnect = () => {
    active?.abort();
    cancelTick?.();
    cancelTick = undefined;
    zone = undefined;
    ranked = undefined;
    void refresh(true);
  };
  const stops = [
    socket.subscribe(reconnect),
    owner.onMessage((message) => {
      if (message.type === "accounts.changed") void refresh(true);
      if (message.type !== "usage.limits_changed") return;
      const account = accountView(message.account);
      const before = accounts.find((known) => known.id === account.id);
      if (!before || loadingAccounts) {
        void refresh(true);
        return;
      }
      if (before.quota.observedAt > account.quota.observedAt) return;
      accounts = accounts.map((known) => (known.id === account.id ? account : known));
      publish();
      void refresh(false);
    }),
  ];
  reconnect();
  const stop = () => {
    active?.abort();
    cancelTick?.();
    for (const each of stops) each();
  };
  return Object.assign(stop, {
    /** Draws these accounts, by id, in this order; an unreadable list falls back to the default. */
    choose(ids: unknown) {
      const parsed = RailPins.safeParse(ids);
      pins = parsed.success ? parsed.data : [];
      publish();
    },
  });
}
