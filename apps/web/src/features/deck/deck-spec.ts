import { ConductorSpec, ProviderKind } from "@ace/protocol";
import type { DeckProviderChoice } from "@ace/ui-core";
import { z } from "zod";

export const MergePolicy = z.enum(["ask", "auto-after-verification", "PR-only"]);
export type MergePolicy = z.infer<typeof MergePolicy>;

/** What the New deck form asks for. */
export const NewDeckInput = z.object({
  goal: z
    .string()
    .trim()
    .min(12, "Describe the goal in a sentence or two.")
    .max(16_384, "Keep the goal under 16,000 characters."),
  workspaceId: z.string().min(1, "Pick a project."),
  worker: ProviderKind,
  reviewer: ProviderKind,
  planApproval: z.boolean(),
  merge: MergePolicy,
  maxParallel: z.number().int().min(1).max(8),
  fixRounds: z.number().int().min(0).max(5),
  budget: z
    .number({ error: "Enter how many lane starts the offset may use." })
    .int("Use a whole number of lane starts.")
    .min(1, "Allow at least one lane start.")
    .max(100_000, "Keep the budget under 100,000 lane starts."),
  stopAfter: z.enum(["none", "2h", "8h", "1d"]),
});
export type NewDeckInput = z.infer<typeof NewDeckInput>;

/** "Stop after": how long the deck may run before its deadline gate asks you. */
export const stopAfterMs: Record<NewDeckInput["stopAfter"], number | null> = {
  none: null,
  "2h": 2 * 3_600_000,
  "8h": 8 * 3_600_000,
  "1d": 24 * 3_600_000,
};

/** Each worker, reviewer or fix run is one lane start: room for about six rounds per lane. */
export function defaultBudget(maxParallel: number): number {
  return Math.max(50, 4 * maxParallel * 6);
}

const role = (choice: DeckProviderChoice) => ({
  provider: choice.provider,
  model: choice.model,
  tier: "normal" as const,
  cost: 1,
  quota: 1,
});

/**
 * A `conductor.start` spec from the form: the worker's provider plans, builds and fixes; the
 * reviewer's provider reviews adversarially. Models and accounts are the daemon's own
 * (`deckProviderChoices`), and `rootAgentId` is the deck's own agent, a UUID. Parsed with the
 * protocol schema, so a spec the daemon would refuse never leaves the form.
 */
export function deckSpec(
  input: NewDeckInput,
  choices: readonly DeckProviderChoice[],
  rootAgentId: string,
  now: number,
): ConductorSpec {
  const pick = (provider: ProviderKind) => {
    const choice = choices.find((entry) => entry.provider === provider);
    if (!choice) throw new Error("provider_unavailable");
    return choice;
  };
  const worker = pick(input.worker);
  const reviewer = pick(input.reviewer);
  const used = worker === reviewer ? [worker] : [worker, reviewer];
  return ConductorSpec.parse({
    rootAgentId,
    workspaceId: input.workspaceId,
    goal: input.goal.trim(),
    repositoryRules: "",
    constraints: {
      providers: used.map((choice) => choice.provider),
      models: [...new Set(used.map((choice) => choice.model))],
      accounts: [...new Set(used.flatMap((choice) => choice.accounts))],
      budget: input.budget,
      maxParallel: input.maxParallel,
      deadline:
        stopAfterMs[input.stopAfter] === null ? null : now + (stopAfterMs[input.stopAfter] ?? 0),
      stallAfterMs: 15 * 60_000,
    },
    policies: {
      planApproval: input.planApproval ? "required" : "auto",
      merge: input.merge,
      maxFixRounds: input.fixRounds,
      roles: {
        planner: [role(worker)],
        worker: [role(worker)],
        reviewer: [role(reviewer)],
        integrator: [role(worker)],
      },
    },
  });
}

/** "make-every-relay-stream-resumable-k3x9": readable and unique enough for a run id. */
export function deckId(goal: string, suffix: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${slug || "deck"}-${suffix}`;
}
