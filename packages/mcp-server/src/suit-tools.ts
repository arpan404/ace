import { z } from "zod";
import { SuitId, SuitProblem } from "@ace/protocol/suits";
import type { SuitApplyOutcome, SuitPreviews } from "./suit-previews.ts";
import type { Toolkit } from "./toolkits.ts";

const SuitApplyInput = z.strictObject({
  mode: z
    .enum(["preview", "keep", "revert"])
    .describe(
      "preview shows it until you keep it or your turn ends; keep stores it; revert ends your preview or undoes your last keep.",
    ),
  id: SuitId.optional().describe(
    "The Suit's folder name in ~/.ace/suits. Needed for preview; keep defaults to your preview.",
  ),
});
/** The JSON part of the result; screenshots follow it as images. */
export const SuitApplyResult = z.object({
  status: z.enum(["previewing", "kept", "reverted", "refused", "not-found", "nothing-to-do"]),
  suit: SuitId.nullable(),
  /** Every failed check when refused; after a preview or keep, what the live check found. */
  problems: z.array(SuitProblem),
  next: z.string(),
  live: z
    .object({
      source: z.enum(["live", "static"]),
      devices: z.array(z.string()),
      unchecked: z.array(z.string()),
      notes: z.array(z.string()),
    })
    .optional(),
});

/** Refusals the agent must act on, shown as failed calls. */
const failures: ReadonlySet<string> = new Set(["refused", "not-found", "nothing-to-do"]);

export const suitToolCatalog = [
  {
    name: "suit_apply",
    title: "Preview, keep or revert a Suit",
    description:
      "Put a Suit (ace look from ~/.ace/suits) on the person's devices. Checks run first: failures come back as problems and nothing applies. A preview or keep then returns what the devices saw as rendered (live problems) and screenshots. Read guide make-a-suit first.",
    input: SuitApplyInput,
    capability: null,
    riskClass: "thread-write",
    toolset: "make-a-suit",
    // Validating renders scene frames for the glass check, then devices check it live (~9 s).
    timeoutMs: 45_000,
  },
] as const;

/** The outcome as MCP content: the JSON, then each screenshot as an image. */
function content(outcome: SuitApplyOutcome) {
  const { screenshots = [], ...rest } = outcome;
  const structured = SuitApplyResult.parse(rest);
  return {
    ...(failures.has(outcome.status) ? { isError: true } : {}),
    content: [
      { type: "text", text: JSON.stringify(structured) },
      ...screenshots.map((shot) => ({ type: "image", mimeType: shot.mimeType, data: shot.data })),
    ],
    structuredContent: structured,
  };
}

/** `suit_apply` (ADR 0150), over the daemon's previews. */
export function suitToolkit(previews: SuitPreviews): Toolkit {
  return {
    register(registry) {
      registry.registerContent({
        ...suitToolCatalog[0],
        async run({ mode, id }, { caller, signal }) {
          if (mode === "revert") return content(await previews.revert(caller));
          if (mode === "keep") return content(await previews.keep(caller, id, signal));
          return content(await previews.preview(caller, id, signal));
        },
      });
    },
  };
}
