import type { Fact } from "@ace/core";
import type { ToolState, TranslationState } from "./state.ts";
import { object, string, type Data } from "./data.ts";
import { createHash } from "node:crypto";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Native cumulative output is checked once per new output frame; core receives suffix deltas. */
export function appendShellOutput(
  s: TranslationState,
  tool: ToolState,
  update: Data,
  facts: Fact[],
): void {
  const output = object(update["rawOutput"]);
  const text =
    typeof output["combinedOutput"] === "string"
      ? output["combinedOutput"]
      : typeof output["stdout"] === "string" || typeof output["stderr"] === "string"
        ? string(output["stdout"]) + string(output["stderr"])
        : undefined;
  if (text === undefined) return;
  const hash = digest(text);
  if (hash === tool.observedOutputDigest) return;
  tool.observedOutputDigest = hash;
  const length = tool.streamedOutputLength ?? 0;
  if (
    text.length < length ||
    (length && digest(text.slice(0, length)) !== tool.streamedOutputDigest)
  ) {
    s.notice(
      facts,
      update["rawOutput"],
      "shell/output-replacement",
      "Shell output replaced earlier text; the replacement is retained in raw data.",
      tool.owner,
    );
    return;
  }
  const append = text.slice(length);
  tool.streamedOutputDigest = hash;
  tool.streamedOutputLength = text.length;
  if (append)
    facts.push({
      type: "item.delta",
      agent: tool.owner.key,
      item: tool.key,
      field: "output",
      append,
    });
}
