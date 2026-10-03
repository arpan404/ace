import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConductorBrief, ConductorPlan, ConductorReview } from "@ace/protocol";
import { deckAskMarker, deckQuestion } from "./real-daemon-config.ts";

/*
 * The Deck roles of the e2e's scripted provider. The native conductor sends each lane a prompt
 * (planner, worker, reviewer); this answers with the artifact that role must return, doing the
 * real Git work a worker does in its private worktree. Nothing here reaches a provider CLI.
 */

export type DeckTurn =
  | { kind: "reply"; text: string }
  /** The worker asks the person first; `answer()` is its reply once they have. */
  | { kind: "ask"; question: string; answer(): string };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=ace e2e", "-c", "user.email=e2e@ace.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** The JSON a prompt quotes after `label`: the conductor encodes quoted data as a JSON string. */
function quoted(text: string, label: string): string | undefined {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${label} (quoted data):`));
  const line = index >= 0 ? lines[index + 1] : undefined;
  if (!line) return undefined;
  const value: unknown = JSON.parse(line);
  return typeof value === "string" ? value : undefined;
}

function brief(text: string, label: string): ConductorBrief {
  const json = quoted(text, label);
  if (!json) throw new Error(`deck prompt without ${label}`);
  return ConductorBrief.parse(JSON.parse(json));
}

const card = (id: string, title: string, dependencies: string[], extra = "") => ({
  id,
  title,
  dependencies,
  priority: 0,
  brief: {
    objective: title,
    instructions: `${title}.${extra}`,
    acceptance: [`${title} is in the project`],
    files: [`${id}.md`],
    packages: [],
    risks: [],
  },
});

/** Two cards, the second after the first: enough for a dependency edge and a merge. */
function plan(goal: string): ConductorPlan {
  const ask = goal.includes(deckAskMarker);
  return ConductorPlan.parse({
    summary: "Add the health note, then document it in the README.",
    workstreams: [
      card("health", "Health note", [], ask ? ` ${deckAskMarker}` : ""),
      card("docs", "Document the health note", ["health"]),
    ],
  });
}

function completion(cwd: string, work: ConductorBrief): string {
  const file = work.files[0] ?? "work.md";
  writeFileSync(join(cwd, file), `# ${work.objective}\n`);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-q", "-m", work.objective);
  const branch = git(cwd, "branch", "--show-current");
  return JSON.stringify({
    kind: "completion",
    completion: { branch, revision: git(cwd, "rev-parse", "HEAD"), summary: work.objective },
  });
}

function review(cwd: string, work: ConductorBrief): string {
  const evidence = "Scripted e2e evidence";
  return JSON.stringify({
    kind: "review",
    revision: git(cwd, "rev-parse", "HEAD"),
    review: ConductorReview.parse({
      verdict: "pass",
      summary: `${work.objective} passes`,
      requirements: work.acceptance.map((criterion) => ({ criterion, passed: true, evidence })),
      probes: [evidence],
      mutations: Array.from({ length: 15 }, (_, index) => ({
        change: `Scripted mutation ${index + 1}`,
        caught: true,
        evidence,
      })),
      flakiness: { runs: 2, passed: true, evidence },
      design: { passed: true, evidence },
      performance: { passed: true, evidence },
    }),
  });
}

/** The turn a Deck lane's prompt asks for, or undefined when the text isn't a Deck prompt. */
export function deckTurn(text: string, cwd: string): DeckTurn | undefined {
  if (text.startsWith("Plan this project.")) {
    const goal = quoted(text, "Goal") ?? "";
    return { kind: "reply", text: JSON.stringify({ kind: "plan", plan: plan(goal) }) };
  }
  if (text.startsWith("Implement this workstream")) {
    const work = brief(text, "Workstream brief");
    if (work.instructions.includes(deckAskMarker))
      return { kind: "ask", question: deckQuestion, answer: () => completion(cwd, work) };
    return { kind: "reply", text: completion(cwd, work) };
  }
  if (text.startsWith("You are the adversarial reviewer.")) {
    const work = brief(text, "Requirements and ownership");
    return { kind: "reply", text: review(cwd, work) };
  }
  return undefined;
}
