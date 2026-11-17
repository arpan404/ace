import type { ThreadReader } from "@ace/client";
import type { Item } from "@ace/protocol";
import {
  formatElapsed,
  readTurnActivity,
  stepLine,
  summarizeWork,
  timedWords,
  workLogHeadline,
  type TurnActivity,
} from "@ace/ui-core";
import { blockItems, type Block } from "@ace/ui-core/transcript-blocks";
import { cutEnd, padStart, safeText, textWidth, wrap } from "../tui/layout.ts";
import type { Paint, StateTone } from "../tui/paint.ts";

/**
 * A thread's transcript as the app shows it (ADR 0176 §9), drawn for a terminal. Pure over the
 * client's thread store and ui-core's blocks: the person's messages, the agent's work folded
 * under "Worked for 3m 12s", answers in full, wrapped, and handoffs, stops and limits as one
 * quiet line each.
 */
export interface DrawnBlock {
  readonly key: string;
  readonly lines: readonly string[];
}

function textOf(item: Item | undefined): string {
  if (!item || item.type !== "message") return "";
  return safeText(
    item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  ).trim();
}

/** The person's message: wrapped narrower and set to the right, as the app's bubble sits. */
function personLines(text: string, width: number, paint: Paint): string[] {
  const room = Math.max(10, Math.min(72, width - 8));
  return wrap(text, room).map((line) => paint.dim(padStart(line, width)));
}

function answerLines(text: string, width: number): string[] {
  return text ? wrap(text, width) : [];
}

function workHead(
  block: Extract<Block, { kind: "work" }>,
  reader: ThreadReader,
  now: number,
): string {
  const ids = block.folded ? block.folded.flatMap((inner) => blockItems(inner)) : block.itemIds;
  const summary = summarizeWork(ids.map((id) => reader.item(id)));
  const head = workLogHeadline(summary, block.until ?? now);
  const label =
    block.outcome === "interrupted"
      ? head.label.replace("Worked for", block.restarted ? "Interrupted after" : "Stopped after")
      : block.outcome === "failed"
        ? head.label.replace("Worked for", "Failed after")
        : head.label;
  return [label, head.counts, head.current].filter(Boolean).join(" · ");
}

const momentWords = {
  restart: "ace restarted, and the turn carried on.",
  limit: "Waited out a usage limit.",
  finished: "Delegated work came back.",
} as const;

/** One block's lines, or none for blocks the foot draws (the live line, open questions). */
export function blockLines(
  block: Block,
  reader: ThreadReader,
  now: number,
  width: number,
  paint: Paint,
): string[] {
  switch (block.kind) {
    case "user":
      return personLines(textOf(reader.item(block.itemId)), width, paint);
    case "message":
      return answerLines(textOf(reader.item(block.itemId)), width);
    case "work": {
      if (block.bare) return [];
      const head = paint.dim(
        cutEnd(`${block.ongoing ? "◌" : "▸"} ${workHead(block, reader, now)}`, width),
      );
      const answers = (block.answerIds ?? []).flatMap((id) =>
        answerLines(textOf(reader.item(id)), width),
      );
      return [head, ...answers];
    }
    case "subagents": {
      const count = block.itemIds.length;
      return [
        paint.dim(cutEnd(`▸ ${count} ${count === 1 ? "subagent" : "subagents"} launched`, width)),
      ];
    }
    case "files":
      return [
        paint.dim(
          cutEnd(
            `Changed ${block.itemIds.length} ${block.itemIds.length === 1 ? "file" : "files"}`,
            width,
          ),
        ),
      ];
    case "moment":
      return [paint.dim(cutEnd(momentWords[block.moment], width))];
    case "item": {
      const item = reader.item(block.itemId);
      if (!item) return [];
      const text = item.type === "notice" ? safeText(item.text) : stepLine(item);
      return [paint.dim(cutEnd(text, width))];
    }
    case "event":
      return [paint.dim(cutEnd(textOf(reader.item(block.itemId)), width))];
    case "started":
      return [
        paint.dim(
          cutEnd(
            `Started a thread: ${textOf(reader.item(block.itemId)) || "see ace thread list"}`,
            width,
          ),
        ),
      ];
    case "forked":
      return [paint.dim(cutEnd(`Forked from ${block.threadId}`, width))];
    case "end":
      return [
        paint.tone(
          block.ending === "failed" ? "failed" : "idle",
          block.ending === "failed" ? "Turn failed." : "Stopped.",
        ),
      ];
    case "live":
    case "question":
      return [];
  }
}

/**
 * Which blocks are settled: printed once into the scrollback and never redrawn. Every block
 * before the person's last message is; the last turn's blocks are once the tree is at rest.
 */
export function settledBlocks(blocks: readonly Block[], atRest: boolean): number {
  if (atRest) {
    const live = blocks.findIndex((block) => block.kind === "live");
    return live < 0 ? blocks.length : live;
  }
  const last = blocks.findLastIndex((block) => block.kind === "user");
  return Math.max(0, last);
}

export interface LiveLine {
  readonly text: string;
  readonly tone: StateTone;
}

const activityTones: Record<TurnActivity["tone"], StateTone> = {
  working: "working",
  "needs-you": "needs-you",
  held: "waiting",
  paused: "limited",
};

/** The live line under the transcript ("Working for 1m 04s · running tests"), if anything is live. */
export function liveLine(reader: ThreadReader, now: number): LiveLine | undefined {
  const root = reader.thread?.rootAgentId;
  if (!root) return undefined;
  const activity = readTurnActivity(reader, root, { threadStatus: reader.thread?.status }).activity;
  if (!activity) return undefined;
  const timed =
    activity.elapsedFrom === undefined
      ? activity.label
      : `${timedWords(activity.label)} ${formatElapsed(now - activity.elapsedFrom)}`;
  const text = [timed, activity.current].filter(Boolean).join(" · ");
  return { text, tone: activityTones[activity.tone] };
}

/** The attached thread's title line: title, project, branch, provider. */
export function titleLine(
  parts: { title: string; project: string; branch: string; provider: string },
  width: number,
  paint: Paint,
): string {
  // Below 60 columns the meta drops, as on the home.
  const meta =
    width < 60 ? "" : [parts.project, parts.branch, parts.provider].filter(Boolean).join(" · ");
  const room = meta ? Math.max(8, width - textWidth(meta) - 2) : width;
  const title = cutEnd(parts.title, room);
  const left = Math.max(0, width - textWidth(title) - 2);
  return meta ? `${paint.bold(title)}  ${paint.dim(cutEnd(meta, left))}` : paint.bold(title);
}
