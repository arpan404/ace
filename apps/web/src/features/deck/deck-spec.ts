import { ConductorSpec, type ProviderKind } from "@ace/protocol";
import { z } from "zod";

export const DeckProvider = z.enum(["claude", "codex", "opencode"]);
export type DeckProvider = z.infer<typeof DeckProvider>;
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
  worker: DeckProvider,
  reviewer: DeckProvider,
  planApproval: z.boolean(),
  merge: MergePolicy,
  maxParallel: z.number().int().min(1).max(8),
  fixRounds: z.number().int().min(0).max(5),
});
export type NewDeckInput = z.infer<typeof NewDeckInput>;

/** The model each provider's lanes use unless the plan says otherwise. */
const defaultModel: Record<DeckProvider, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5.3-codex",
  opencode: "kimi-k2",
};

const model = (provider: ProviderKind & DeckProvider) => ({
  provider,
  model: defaultModel[provider],
  tier: "normal" as const,
  cost: 1,
  quota: 1,
});

/**
 * A `conductor.start` spec from the form: the worker's provider plans, builds and
 * integrates; the reviewer's provider reviews adversarially. Parsed with the protocol schema,
 * so a spec the daemon would refuse never leaves the form.
 */
export function deckSpec(input: NewDeckInput, rootAgentId: string): ConductorSpec {
  const providers = [...new Set([input.worker, input.reviewer])];
  return ConductorSpec.parse({
    rootAgentId,
    workspaceId: input.workspaceId,
    goal: input.goal.trim(),
    repositoryRules: "",
    constraints: {
      providers,
      models: providers.map((provider) => defaultModel[provider]),
      accounts: ["default"],
      budget: 50,
      maxParallel: input.maxParallel,
      deadline: null,
      stallAfterMs: 15 * 60_000,
    },
    policies: {
      planApproval: input.planApproval ? "required" : "auto",
      merge: input.merge,
      maxFixRounds: input.fixRounds,
      roles: {
        planner: [model(input.worker)],
        worker: [model(input.worker)],
        reviewer: [model(input.reviewer)],
        integrator: [model(input.worker)],
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
