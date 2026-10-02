/**
 * Provider-neutral scenarios. Each one isolates a behaviour the canonical
 * model depends on (see docs/adr/0005-fixture-contract-tests.md).
 */
export type ScenarioId =
  | "tool-read"
  | "approval-edit"
  | "question"
  | "plan-review"
  | "subagent"
  | "subagent-background"
  | "background-shell"
  | "interrupt";

export type Scenario = {
  id: ScenarioId;
  prompt: string;
  /** Ask the provider to plan instead of acting, where it has such a mode. */
  planMode?: boolean;
  /** Send an interrupt this long after the first tool call starts. */
  interruptAfterToolStartMs?: number;
  /** Stop once a turn has ended and nothing meaningful arrived for this long. */
  quietMs: number;
  /** Hard cap on the whole run. */
  maxMs: number;
  /** How the scripted responder answers plan reviews. */
  planDecision?: "approve" | "reject";
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "tool-read",
    prompt:
      "Read src/math.ts and tell me in one sentence what it exports. Do not modify any files.",
    quietMs: 8_000,
    maxMs: 120_000,
  },
  {
    id: "approval-edit",
    prompt:
      "Add an exported function `subtract(a: number, b: number): number` to src/math.ts. Make only that change.",
    quietMs: 8_000,
    maxMs: 180_000,
  },
  {
    id: "question",
    prompt:
      "Before doing anything else, use your tool for asking the user a multiple-choice question to ask whether I prefer Tabs or Spaces. Offer exactly two options: Tabs and Spaces. Then reply with one sentence confirming my answer. Do not modify any files.",
    quietMs: 8_000,
    maxMs: 180_000,
  },
  {
    id: "plan-review",
    prompt:
      "Plan how you would add input validation to the functions in src/math.ts. Present the plan for my approval before changing anything.",
    planMode: true,
    planDecision: "reject",
    quietMs: 10_000,
    maxMs: 240_000,
  },
  {
    id: "subagent",
    prompt:
      "Use a subagent (your task/agent delegation tool) to count the lines in each file under src/ and report the counts back to you. Do not count them yourself. Then give me the totals.",
    quietMs: 10_000,
    maxMs: 300_000,
  },
  {
    id: "subagent-background",
    prompt:
      "Start a subagent in the background to summarize README.md in one sentence. Do not wait for it: reply with just the word 'started' right away. When the subagent's result arrives later, reply with its summary.",
    quietMs: 30_000,
    maxMs: 300_000,
  },
  {
    id: "background-shell",
    prompt:
      "Run the shell command `sleep 15 && echo finished` in the background without waiting for it, and immediately reply with just the word 'launched'. When the command completes, tell me its output.",
    quietMs: 30_000,
    maxMs: 240_000,
  },
  {
    id: "interrupt",
    prompt:
      "Run the shell command `sleep 60 && echo done` and wait for it to finish, then tell me.",
    interruptAfterToolStartMs: 8_000,
    quietMs: 8_000,
    maxMs: 180_000,
  },
];

export function findScenario(id: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);
  return scenario;
}
