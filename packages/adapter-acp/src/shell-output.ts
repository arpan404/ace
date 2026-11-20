import type { Fact } from "@ace/core";
import type { ToolState, TranslationState } from "./state.ts";
import { object, type Data } from "./data.ts";
import { createHash } from "node:crypto";

/**
 * What one native output stream has published: its length and digests of the text that starts
 * and ends it. Digests, not slices: a slice would keep the whole native snapshot alive.
 */
interface Stream {
  length: number;
  head: string;
  tail: string;
}
const edge = 256;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const head = (text: string, length: number) => digest(text.slice(0, Math.min(edge, length)));
const tail = (text: string, length: number) =>
  digest(text.slice(Math.max(0, length - edge), length));

/**
 * Native output arrives as cumulative snapshots: `combinedOutput`, or `stdout` and `stderr`.
 * Each stream is followed on its own, so one growing never freezes the other, and core receives
 * only the appended text. A snapshot continues a stream when it is at least as long and keeps the
 * text that started and ended it, so a frame costs the size of its change, never of the whole
 * output; a replacement inside the middle alone is not detected, and stays in raw data.
 */
export class ShellOutput {
  private readonly streams = new WeakMap<ToolState, Map<string, Stream>>();

  append(s: TranslationState, tool: ToolState, update: Data, facts: Fact[]): void {
    const output = object(update["rawOutput"]);
    const snapshots: [string, string][] =
      typeof output["combinedOutput"] === "string"
        ? [["combined", output["combinedOutput"]]]
        : (["stdout", "stderr"] as const).flatMap((name): [string, string][] => {
            const text = output[name];
            return typeof text === "string" ? [[name, text]] : [];
          });
    if (!snapshots.length) return;
    let streams = this.streams.get(tool);
    if (!streams) this.streams.set(tool, (streams = new Map()));
    let append = "";
    for (const [name, text] of snapshots) {
      const stream = streams.get(name);
      const length = stream?.length ?? 0;
      const continues =
        !stream ||
        (text.length >= length &&
          head(text, length) === stream.head &&
          tail(text, length) === stream.tail);
      if (continues && text.length === length) continue;
      if (!continues) {
        s.notice(
          facts,
          update["rawOutput"],
          "shell/output-replacement",
          "Shell output replaced earlier text; the replacement is retained in raw data.",
          tool.owner,
        );
        continue;
      }
      append += text.slice(length);
      streams.set(name, {
        length: text.length,
        head: head(text, text.length),
        tail: tail(text, text.length),
      });
    }
    if (append)
      facts.push({
        type: "item.delta",
        agent: tool.owner.key,
        item: tool.key,
        field: "output",
        append,
      });
  }
}
