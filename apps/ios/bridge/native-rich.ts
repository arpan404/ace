import { mathSpans, readDiffText } from "@ace/ui-core";
import { z } from "zod";
import { colourRuns } from "./checkout-colours.ts";

/*
 * What a finished answer draws beyond plain Markdown, asked for once it stops streaming so a
 * streamed delta never pays for it: its formulas (shared `mathSpans`), and a fenced block's
 * grammar colours (shared `colourRuns`, as the file screen draws them) or, for a diff fence, its
 * lines classified by the shared diff reader. Pure over the request.
 */

/** Past this a block shows plain: colouring it would cost more than it reads better. */
const codeLimit = 64 * 1024;
const diffLanguages = new Set(["diff", "patch", "udiff"]);

export const NativeRichRequest = z.discriminatedUnion("kind", [
  z.object({
    type: z.literal("native.rich"),
    kind: z.literal("prose"),
    text: z.string().max(400_000),
  }),
  z.object({
    type: z.literal("native.rich"),
    kind: z.literal("code"),
    language: z.string().max(64),
    text: z.string().max(codeLimit),
  }),
]);

export async function readNativeRich(request: z.infer<typeof NativeRichRequest>) {
  return request.kind === "prose"
    ? richProse(request.text)
    : richCode(request.language, request.text);
}

/**
 * Each formula marked where it sits, for the phone to typeset (`Sources/Models/MathRenderer`)
 * and to show in its text form until then, or if it can't be.
 */
export function richProse(text: string) {
  return mathSpans(text);
}

/** A fenced block's colours, or a diff fence's classified lines. */
export async function richCode(fence: string, text: string) {
  const language = fence.toLowerCase();
  if (diffLanguages.has(language)) {
    const diff = readDiffText(text);
    return {
      diff: diff.lines.map((line) => ({ kind: line.kind, text: line.text })),
      colours: [],
      runs: [],
    };
  }
  const runs = await colourRuns(text, language);
  return { diff: null, colours: runs?.colours ?? [], runs: runs?.runs ?? [] };
}
