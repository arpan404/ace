import { pluralCount } from "./counts.ts";
import type { ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import { describeWake } from "./snooze.ts";
import type { Tone } from "./status.ts";
import { formatClock } from "./time.ts";

/*
 * What a thread is actually doing, in words, beyond its state: watching a background command,
 * waiting on its subagents, running tests, waiting for the person's answer, held at a usage
 * limit. One wording for every surface (the transcript's live line, the sidebar row, the
 * header), whether the facts come from the daemon's live hints on the thread list or from a
 * loaded thread. Pure.
 */

export type LiveFact =
  /** A request waits on the person; `request` is what it asks for (an interaction kind). */
  | { kind: "asking"; request: string }
  | { kind: "limited"; until: number | undefined }
  | { kind: "subagents"; count: number }
  /** Background work holds the thread; `title` names it when there is exactly one. */
  | { kind: "watching"; count: number; title: string | undefined }
  | { kind: "tests" };

export interface LiveStatus {
  /** "Waiting on 2 subagents", "Watching", "Limited until 3:20 PM". */
  label: string;
  /** A command the label names, shown as code after it: "bun run dev:relay". */
  code: string | undefined;
  tone: Tone;
}

const hour = 3_600_000;

/** "Waiting for your approval" / "… your review" / "… your answer", by what is asked. */
export function askingLabel(request: string): string {
  if (request === "approval") return "Waiting for your approval";
  if (request === "plan_review") return "Waiting for your review";
  return "Waiting for your answer";
}

/** "Limited until 3:20 PM" (with the day when it is further off), or "Limited". */
export function limitedLabel(until: number | undefined, now: number, locale?: string): string {
  if (until === undefined || until <= now) return "Limited";
  return `Limited until ${until - now < 20 * hour ? formatClock(until, locale) : describeWake(until, now, locale)}`;
}

/** A live fact in words, with its tone. */
export function describeLive(fact: LiveFact, now: number, locale?: string): LiveStatus {
  switch (fact.kind) {
    case "asking":
      return { label: askingLabel(fact.request), code: undefined, tone: "needs-you" };
    case "limited":
      return { label: limitedLabel(fact.until, now, locale), code: undefined, tone: "waiting" };
    case "subagents":
      return {
        label: `Waiting on ${pluralCount(fact.count, "subagent", "subagents")}`,
        code: undefined,
        tone: "working",
      };
    case "watching":
      return fact.count === 1 && fact.title
        ? { label: "Watching", code: fact.title, tone: "waiting" }
        : {
            label: `Watching ${pluralCount(fact.count, "background task", "background tasks")}`,
            code: undefined,
            tone: "waiting",
          };
    case "tests":
      return { label: "Running tests…", code: undefined, tone: "working" };
  }
}

/** The status as one line of text: "Watching bun run dev:relay". */
export function liveStatusText(status: LiveStatus): string {
  return status.code ? `${status.label} ${status.code}` : status.label;
}

/**
 * What a listed thread is doing, from its status and the daemon's live hints, when they say
 * more than the status alone. Undefined for a thread that is simply working, done or new.
 */
export function threadLiveFact(thread: {
  status: ThreadStatus;
  live?: ThreadRunMetadata | undefined;
}): LiveFact | undefined {
  const { status, live } = thread;
  switch (status.state) {
    case "needs_you": {
      const request = live?.asking?.[0]?.kind;
      return request ? { kind: "asking", request } : undefined;
    }
    case "limited":
      return { kind: "limited", until: status.until };
    case "working":
      if (live?.waitingOn) return { kind: "subagents", count: live.waitingOn };
      return live?.step === "tests" ? { kind: "tests" } : undefined;
    case "waiting": {
      if (status.on !== "background_task") return undefined;
      const watching = live?.watching ?? [];
      const count = watching.length || live?.backgroundTaskCount || 1;
      return { kind: "watching", count, title: count === 1 ? watching[0]?.title : undefined };
    }
    default:
      return undefined;
  }
}

/** Queue holds are waiting input, with no running provider to stop. */
export function threadIsRunning(status: ThreadStatus | undefined): boolean {
  return (
    status?.state === "working" ||
    status?.state === "needs_you" ||
    status?.state === "unresponsive" ||
    (status?.state === "waiting" && status.on !== "queue" && status.on !== "background_task")
  );
}
