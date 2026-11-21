import { randomUUID } from "node:crypto";
import type { ClientApi } from "@ace/client";
import { ScreenClient } from "@ace/client/screen";
import { UsageQuery, type ThreadListEntry } from "@ace/protocol";
import {
  accountView,
  formatElapsed,
  hoverStatusLine,
  isRemoteChild,
  knownTimeZone,
  railUsage,
  threadCard,
  threadLiveFact,
  usageDay,
  usageLimits,
  type RailMeasure,
  type RailPins,
} from "@ace/ui-core";
import { screenSession } from "@ace/ui-core/computer-use";
import type { TrayAction } from "./native-tray-action.ts";

export function listedInTray(entry: ThreadListEntry): boolean {
  if (entry.archivedAt !== undefined || isRemoteChild(entry)) return false;
  return (
    entry.status.state === "needs_you" ||
    entry.status.state === "working" ||
    entry.status.state === "waiting"
  );
}

export function trayThread(entry: ThreadListEntry, now: number) {
  const card = threadCard({ entry, now, baseline: 0, settled: false });
  const line = hoverStatusLine({ card, attention: card.attention, fact: threadLiveFact(entry) });
  const since = card.status.since;
  return {
    id: entry.id,
    title: card.title,
    status: line.detail?.text ?? line.sentence ?? card.status.label,
    provider: card.provider,
    needsYou: entry.status.state === "needs_you",
    elapsed: since === undefined ? undefined : formatElapsed(Math.max(0, now - since)),
    updatedAt: entry.updatedAt,
  };
}

export async function trayApps(client: ClientApi, signal: AbortSignal) {
  const screen = new ScreenClient(client);
  const [status, sessions] = await Promise.all([
    screen.status({ signal }),
    screen.sessions({ signal }),
  ]);
  return {
    enabled: status.enabled,
    rows: sessions
      .filter(({ lifecycle }) => lifecycle === "live" || lifecycle === "starting")
      .map((state) => {
        const view = screenSession(state);
        return {
          id: state.sessionId,
          title: view.app,
          bundleId: view.bundleId,
          status: view.error ?? view.status,
          mode: view.foreground ? "In front" : "Background",
          canTakeOver: !view.viewOnly && state.controller !== "human",
          canStop: view.stoppable,
        };
      }),
  };
}

export interface TrayUsagePreferences {
  measure: RailMeasure;
  pins: RailPins;
}

export async function trayUsage(
  client: ClientApi,
  now: number,
  signal: AbortSignal,
  preferences?: TrayUsagePreferences,
) {
  const listed = await client.request({ type: "accounts.list" }, { signal });
  const accounts = listed.accounts.map((account) => ({
    account: accountView(account),
    environment: "This machine",
  }));
  const limits = usageLimits(accounts, now);
  const day = (offset = 0, zone?: string) => usageDay(now, zone, offset);
  const tokens = await (async () => {
    const today = day();
    const zoneReply = await client.request(
      {
        type: "usage.summary",
        query: UsageQuery.parse({ from: today, to: today, limit: 1 }),
      },
      { signal },
    );
    const zone = knownTimeZone(zoneReply.result.timezone);
    const reply = await client.request(
      {
        type: "usage.summary",
        query: UsageQuery.parse({
          from: day(6, zone),
          to: day(0, zone),
          groupBy: ["account"],
          limit: 100,
        }),
      },
      { signal },
    );
    return new Map(
      reply.result.rows.map(({ dimensions, totals }) => [
        dimensions.account ?? "",
        totals.inputTokens + totals.outputTokens,
      ]),
    );
  })().catch(() => undefined);
  const rail = railUsage(limits, tokens, preferences?.measure, preferences?.pins);
  const observedAt = rail.accounts.reduce(
    (latest, account) =>
      Math.max(
        latest,
        account.account.quota.observedAt,
        ...account.windows.map((window) => window.observedAt),
      ),
    0,
  );
  return {
    observedAt,
    rows: rail.accounts.map(({ key, account, windows, signIn, bankedResets }) => ({
      id: key,
      accountId: account.id,
      title: account.label,
      provider: account.providerLabel,
      signIn,
      bankedResets,
      windows: windows.map(({ id, label, leftPercent, stale, resetsAt }) => ({
        id,
        label,
        left: stale ? null : leftPercent,
        resetsAt,
      })),
    })),
  };
}

export async function applyTrayServiceAction(
  client: ClientApi,
  action: TrayAction,
  signal: AbortSignal,
): Promise<void> {
  const screen = new ScreenClient(client);
  switch (action.action) {
    case "pause": {
      const reply = await client.request(
        {
          type: "admission.request",
          operation: action.paused ? "pause" : "resume",
        },
        { signal },
      );
      if (!reply.ok) throw new Error("Couldn’t change whether ace accepts new work");
      break;
    }
    case "enable":
      await screen.enable(action.enabled, { signal });
      break;
    case "takeover":
      await screen.takeover(action.id, { signal });
      break;
    case "stop":
      await screen.stop(action.id, { signal });
      break;
    case "reset": {
      const reply = await client.request(
        { type: "accounts.consumeReset", instanceId: action.id, idempotencyKey: randomUUID() },
        { signal },
      );
      if (reply.outcome !== "reset" && reply.outcome !== "alreadyRedeemed")
        throw new Error("Couldn’t use the banked reset");
      break;
    }
  }
}
