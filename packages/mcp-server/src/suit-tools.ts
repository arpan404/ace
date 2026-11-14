import { z } from "zod";
import { SuitId, SuitProblem } from "@ace/protocol/suits";
import type { SuitPreviews } from "./suit-previews.ts";
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
const SuitApplyResult = z.object({
  status: z.enum(["previewing", "kept", "reverted", "refused", "not-found", "nothing-to-do"]),
  suit: SuitId.nullable(),
  /** Every failed check when refused; nothing applies until it is empty. */
  problems: z.array(SuitProblem),
  next: z.string(),
});

/** Refusals the agent must act on, shown as failed calls. */
const failures: ReadonlySet<string> = new Set(["refused", "not-found", "nothing-to-do"]);

export const suitToolCatalog = [
  {
    name: "suit_apply",
    title: "Preview, keep or revert a Suit",
    description:
      "Put a Suit (ace look from ~/.ace/suits) on the person's devices. Checks run first: failures come back as problems and nothing applies. Read guide make-a-suit first.",
    input: SuitApplyInput,
    output: SuitApplyResult,
    capability: null,
    riskClass: "thread-write",
    toolset: "make-a-suit",
    // Validating renders scene frames for the glass check.
    timeoutMs: 30_000,
  },
] as const;

/** `suit_apply` (ADR 0150), over the daemon's previews. */
export function suitToolkit(previews: SuitPreviews): Toolkit {
  return {
    register(registry) {
      registry.register({
        ...suitToolCatalog[0],
        failed: (result) => failures.has(result.status),
        async run({ mode, id }, { caller, signal }) {
          if (mode === "revert") return previews.revert(caller);
          if (mode === "keep") return previews.keep(caller, id, signal);
          return previews.preview(caller, id, signal);
        },
      });
    },
  };
}
