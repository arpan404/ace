import type { ThreadReader } from "@ace/client";
import { agentName, agentStatusLabel, isRunning, type Tone } from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";

/*
 * What the pinned summary card reads from the live thread, as plain values: its subagents, the
 * files and images attached to its messages, and what waits on the person. Selectors for
 * `useThread`, each with an equality so the card re-renders only when what it shows changes.
 */

export interface SubagentMark {
  id: string;
  name: string;
  provider: ProviderKind;
  acpAgentId: string | undefined;
  tone: Tone;
  running: boolean;
}

/** Subagents only, oldest first: the root agent is the conversation itself. */
export const subagentsOf = (reader: ThreadReader): SubagentMark[] =>
  reader.agentIds().flatMap((id) => {
    const agent = reader.agent(id);
    if (!agent || agent.origin === "root") return [];
    return [
      {
        id,
        name: agentName(agent),
        provider: agent.native.provider,
        acpAgentId: agent.native.acpAgentId,
        tone: agentStatusLabel(agent.status).tone,
        running: isRunning(agent),
      },
    ];
  });

export const sameMarks = (a: readonly SubagentMark[], b: readonly SubagentMark[]) =>
  a.length === b.length &&
  a.every((mark, i) => mark.id === b[i]?.id && mark.tone === b[i].tone && mark.name === b[i].name);

/** "1 needs you · 2 running · 4 done": what needs a look first. */
export function subagentSummary(marks: readonly SubagentMark[]): string {
  const count = (test: (mark: SubagentMark) => boolean) => marks.filter(test).length;
  const needsYou = count((mark) => mark.tone === "needs-you");
  const failed = count((mark) => mark.tone === "failed");
  const running = count((mark) => mark.running && mark.tone !== "needs-you");
  const done = marks.length - needsYou - failed - running;
  return [
    needsYou && `${needsYou} need${needsYou === 1 ? "s" : ""} you`,
    failed && `${failed} failed`,
    running && `${running} running`,
    done && `${done} done`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface Source {
  key: string;
  kind: "file" | "image";
  /** The file name, or "Image" with its type. */
  title: string;
  /** A file's path as the message carried it. */
  path?: string | undefined;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * Files and images attached to the person's messages in the loaded part of the transcript,
 * newest first, each once. The daemon keeps no list of a thread's context yet, so older pages
 * that haven't loaded aren't counted.
 */
export const sourcesOf = (reader: ThreadReader): Source[] => {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const id of reader.order.toReversed()) {
    const item = reader.item(id);
    if (item?.type !== "message" || item.role !== "user") continue;
    for (const [index, part] of item.parts.entries()) {
      if (part.type === "file" && !seen.has(part.path)) {
        seen.add(part.path);
        sources.push({ key: part.path, kind: "file", title: basename(part.path), path: part.path });
      } else if (part.type === "image") {
        const type = part.mimeType.replace(/^image\//, "").toUpperCase();
        sources.push({ key: `${id}:${index}`, kind: "image", title: `Image · ${type}` });
      }
    }
  }
  return sources;
};

export const sameSources = (a: readonly Source[], b: readonly Source[]) =>
  a.length === b.length && a.every((source, i) => source.key === b[i]?.key);

/** Approvals, questions and plans waiting on the person. */
export const pendingInteractions = (reader: ThreadReader): number =>
  reader.interactionIds().filter((id) => reader.interaction(id)?.state === "pending").length;

export const runningShell = (reader: ThreadReader): string | undefined =>
  reader.taskIds().findLast((id) => {
    const task = reader.task(id);
    return task?.kind === "shell" && task.status === "running";
  });

export const runningTasks = (reader: ThreadReader): number =>
  reader.taskIds().filter((id) => reader.task(id)?.status === "running").length;
