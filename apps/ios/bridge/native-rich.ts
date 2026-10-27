import { proseMath, readDiffText } from "@ace/ui-core";
import { z } from "zod";
import { colourRuns } from "./checkout-colours.ts";

/*
 * What a finished answer draws beyond plain Markdown, asked for once it stops streaming so a
 * streamed delta never pays for it: its math as text (shared `proseMath`), and a fenced block's
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
  if (request.kind === "prose") return { text: proseMath(request.text) };
  const language = request.language.toLowerCase();
  if (diffLanguages.has(language)) {
    const diff = readDiffText(request.text);
    return {
      diff: diff.lines.map((line) => ({ kind: line.kind, text: line.text })),
      colours: [],
      runs: [],
    };
  }
  const runs = await colourRuns(request.text, language);
  return { diff: null, colours: runs?.colours ?? [], runs: runs?.runs ?? [] };
}
