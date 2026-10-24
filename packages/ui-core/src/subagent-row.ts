import type { Agent } from "@ace/protocol";
import { describeActivity } from "./agents.ts";
import { effortLabel, optionEffort } from "./models.ts";
import { modelLabel } from "./providers.ts";
import type { SubagentEntry } from "./subagent-group.ts";
import { subagentTerminal, type SubagentState } from "./subagents.ts";
import { formatElapsed } from "./time.ts";

/*
 * The words of one subagent row, shared by the web and native transcripts: its meta ("Opus 4.7 ·
 * High"), its second line (what it does now, waits on, failed with or found) and how long it
 * ran. Pure.
 */

export type SubagentDetailKind = "live" | "result" | "human" | "failed";

export interface SubagentDetail {
  detail?: string | undefined;
  kind?: SubagentDetailKind | undefined;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The row's second line. Live activity shows only while the thread's facts are fresh: a cached
 * copy never claims what an agent does now.
 */
export function subagentDetail(
  entry: Pick<SubagentEntry, "state" | "agentId" | "result">,
  agent: Pick<Agent, "status"> | undefined,
  toolTitle: string | undefined,
  fresh: boolean,
): SubagentDetail {
  const status = agent?.status;
  if (entry.state === "queued") return { detail: queuedDetail };
  if (entry.state === "human") return { detail: "Waiting for you", kind: "human" };
  if (entry.state === "failed") {
    const error = status?.state === "failed" ? status.error : undefined;
    return { detail: error?.title ?? error?.message ?? entry.result, kind: "failed" };
  }
  if (subagentTerminal(entry.state) || !entry.agentId)
    return { detail: entry.result, kind: entry.result ? "result" : undefined };
  if (!fresh || !status || (status.state !== "working" && status.state !== "starting")) return {};
  return { detail: sentence(describeActivity(status, toolTitle)), kind: "live" };
}

/** Why a queued subagent hasn't started, in its row and its own thread. */
export const queuedDetail = "Starts when a running agent finishes";

/** Whether a subagent's row shows a ticking time: it runs. One still queued has not started. */
export function subagentRunning(state: SubagentState): boolean {
  return !subagentTerminal(state) && state !== "queued";
}

/** The item a working agent runs now, whose title names its activity. */
export function subagentToolId(agent: Pick<Agent, "status"> | undefined): string | undefined {
  const status = agent?.status;
  return status?.state === "working" && status.itemId ? status.itemId : undefined;
}

/** "Opus 4.7 · High" for a subagent; "Delegated · GPT-5.5 · High" for a thread ace delegated. */
export function subagentMeta(
  entry: Pick<SubagentEntry, "childThreadId" | "model">,
  execution?: { model?: string | undefined; options?: Readonly<Record<string, unknown>> | null },
): string | undefined {
  const model = entry.model ?? execution?.model;
  const effort = optionEffort(execution?.options);
  const parts = [
    entry.childThreadId ? "Delegated" : undefined,
    model ? modelLabel(model) : undefined,
    effort ? effortLabel(effort) : undefined,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : undefined;
}

/** When a set of subagents ran: from the first launch, to the last end once every one ended. */
export function subagentSpan(
  entries: readonly Pick<SubagentEntry, "state" | "startedAt" | "endedAt">[],
): {
  running: boolean;
  startedAt: number;
  endedAt?: number | undefined;
} {
  const running = entries.some((entry) => !subagentTerminal(entry.state));
  const startedAt = Math.min(...entries.map((entry) => entry.startedAt));
  const ends = entries.flatMap((entry) => (entry.endedAt === undefined ? [] : [entry.endedAt]));
  const endedAt = !running && ends.length === entries.length ? Math.max(...ends) : undefined;
  return { running, startedAt, endedAt };
}

const week = 7 * 24 * 3_600_000;

/**
 * How long it ran, as shown beside its status: ticking from `since` while it runs and the facts
 * are fresh, else the settled duration. Nothing under a second, past a week, or for a run whose
 * facts are stale.
 */
export function subagentElapsed(
  span: { running: boolean; startedAt: number; endedAt?: number | undefined },
  fresh: boolean,
): { since: number } | { text: string } | undefined {
  if (!span.startedAt) return undefined;
  if (span.running) return fresh ? { since: span.startedAt } : undefined;
  if (span.endedAt === undefined) return undefined;
  const elapsed = span.endedAt - span.startedAt;
  if (elapsed < 1000 || elapsed >= week) return undefined;
  return { text: formatElapsed(elapsed) };
}

/** Whether a ticking elapsed label still shows at `now` (under a second or past a week, not). */
export function elapsedShown(elapsed: number): boolean {
  return elapsed >= 1000 && elapsed < week;
}
