import { useSyncExternalStore } from "react";
import { z } from "zod";
import { useSidebarAll } from "@ace/client-react";
import { fixingNow, liveFixMarks, threadCard, type FixMark } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { usePrDetail, usePrIdentity, type PrIdentity } from "./pr-review-context.tsx";

/*
 * Fix with agent requests, kept on this device per pull request, so the thread or check a
 * request came from can say "Agent fixing this" until the agent pushes and replies.
 */

const Marks = z
  .array(
    z.object({
      subject: z.string().max(512),
      agentThreadId: z.string().max(256),
      headSha: z.string().max(64),
      at: z.string().max(64),
    }),
  )
  .max(200);
const storageKey = (identity: PrIdentity) => `pr:${identity.workspaceId}:${identity.prKey}:fixing`;
const listeners = new Set<() => void>();
const parsed = new Map<string, { raw: string | null; marks: readonly FixMark[] }>();
const none: readonly FixMark[] = [];

function read(key: string): readonly FixMark[] {
  const raw = globalThis.localStorage?.getItem(key) ?? null;
  const known = parsed.get(key);
  if (known && known.raw === raw) return known.marks;
  let marks: readonly FixMark[] = none;
  try {
    marks = raw ? Marks.parse(JSON.parse(raw)) : none;
  } catch {
    marks = none;
  }
  parsed.set(key, { raw, marks });
  return marks;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  globalThis.addEventListener?.("storage", listener);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", listener);
  };
}

/**
 * Remember that `subject` (`thread:<id>` or `check:<id>`) was sent to `agentThreadId` at the
 * PR's `headSha`; marks already cleared or expired are dropped as it writes.
 */
export function recordFixMark(
  identity: PrIdentity,
  mark: FixMark,
  status: Parameters<typeof liveFixMarks>[1],
  now: number,
) {
  const key = storageKey(identity);
  const kept = liveFixMarks(read(key), status, now).filter((m) => m.subject !== mark.subject);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify([...kept, mark].slice(-200)));
  } catch {
    // Storage full or off: the mark is a hint, and the request itself was still delivered.
  }
  for (const listener of listeners) listener();
}

const busyTones = new Set(["working", "waiting", "background"]);

/** Whether the agent asked to fix `subject` is working on it now. */
export function useFixingNow(subject: string): boolean {
  const identity = usePrIdentity();
  const detail = usePrDetail();
  const now = useNow();
  const key = identity ? storageKey(identity) : "";
  const marks = useSyncExternalStore(
    subscribe,
    () => (key ? read(key) : none),
    () => none,
  );
  const mine = marks.filter((m) => m.subject === subject);
  const busy =
    useSidebarAll((reader) =>
      mine
        .filter((m) => {
          const entry = reader.thread(m.agentThreadId);
          return (
            entry &&
            busyTones.has(threadCard({ entry, baseline: 0, settled: false, now }).status.tone)
          );
        })
        .map((m) => m.agentThreadId)
        .join("\n"),
    ) ?? "";
  if (!detail || !mine.length) return false;
  const working = new Set(busy.split("\n"));
  return fixingNow(subject, mine, detail.status, (id) => working.has(id), now);
}
