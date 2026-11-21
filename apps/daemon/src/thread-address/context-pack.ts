import { isAgentProse } from "@ace/projection";
import type { Item } from "@ace/protocol";
import { sharedTurns, sharesWords, type ShareFacts } from "@ace/ui-core/mention-shares";

/*
 * The context pack a bot or club gets with a message the person sends from a thread (ADR 0198):
 * the thread's title, its project, its branch and pull request, the files the message names and
 * its last few turns, each line passed through `redact` first so no secret leaves. Exactly what
 * `sharesWords` names, so the person's "Shares: …" line is the truth. Pure.
 */

/** The pack's whole size; a turn that doesn't fit is cut, never the header. */
const packBytes = 8 * 1024;
/** One message's share of the pack. */
const messageChars = 1_200;

export interface PackThread extends Omit<ShareFacts, "files"> {
  title: string;
}

/** Each turn of the thread: the person's words and what the agent said back, oldest first. */
function turns(items: readonly Item[]): { person: string; agent: string }[] {
  const out: { person: string; agent: string }[] = [];
  for (const item of items) {
    if (item.type !== "message" || item.speaker) continue;
    const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    if (!text.trim()) continue;
    if (item.role === "user" && !item.synthetic) out.push({ person: text.trim(), agent: "" });
    else if (isAgentProse(item) && out.length) {
      const last = out[out.length - 1];
      if (last) last.agent = `${last.agent}\n${text}`.trim();
    }
  }
  return out.slice(-sharedTurns);
}

const clip = (text: string) =>
  text.length > messageChars ? `${text.slice(0, messageChars)}…` : text;

export function contextPack(
  thread: PackThread,
  files: readonly string[],
  items: readonly Item[],
  redact: (text: string) => string,
): { pack: string; shares: string[] } {
  const shares = sharesWords({ ...thread, files: files.length }, "thread");
  const about = [
    thread.project ? `project ${thread.project}` : "a chat",
    ...(thread.branch ? [`branch ${thread.branch}`] : []),
    ...(thread.pullRequest ? [`PR #${thread.pullRequest}`] : []),
  ].join(", ");
  const lines = [`From the ace thread "${redact(thread.title)}" (${redact(about)}).`];
  if (files.length) lines.push(`Files the message names: ${files.map(redact).join(", ")}`);
  const shown = turns(items);
  if (shown.length)
    lines.push(`Its last ${shown.length === 1 ? "turn" : `${shown.length} turns`}:`);
  for (const turn of shown) {
    lines.push(`person: ${redact(clip(turn.person))}`);
    if (turn.agent) lines.push(`agent: ${redact(clip(turn.agent))}`);
  }
  let pack = "";
  for (const line of lines) {
    if (Buffer.byteLength(pack) + Buffer.byteLength(line) + 1 > packBytes) break;
    pack += `${pack ? "\n" : ""}${line}`;
  }
  return { pack, shares };
}
