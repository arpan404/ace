import type { Scenario } from "../scenarios.ts";
/** Drafts only. The recorder is never run without a separate quota/time approval. */
export const openCodeRecordingCandidates = [
  { id: "tool-read", evidence: "Native execution/tool order and projected messages" },
  { id: "approval-edit", evidence: "action/resources/source and once reply" },
  { id: "question", evidence: "q0/q1 keyed answers, multi-select and dismissal" },
  { id: "subagent", evidence: "Verified parent edge, child transcript and child approval" },
  {
    id: "subagent-background",
    evidence: "Parent terminal, child work, synthetic wake and continuation",
  },
  { id: "background-shell", evidence: "Native shell ownership, completion and synthetic wake" },
  { id: "interrupt", evidence: "Acknowledgement, foreground cleanup and terminal ordering" },
  {
    id: "retry-overloaded",
    evidence: "Controlled structured retry; no repeated real overload attempts",
  },
  {
    id: "plan-review",
    evidence: "Conditional configured v2 agent/form flow; otherwise unsupported metadata",
  },
] as const;
export function openCodeScenario(scenario: Scenario): Scenario {
  if (scenario.id === "background-shell")
    return {
      ...scenario,
      prompt:
        "Use the native shell tool with background=true to run `sleep 15 && echo finished`. Reply 'launched' immediately. When its completion wakes you, report the output. Do not use nohup or detached shell jobs.",
    };
  if (scenario.id === "question")
    return {
      ...scenario,
      prompt:
        "Use your question tool to ask two questions: q0, Tabs or Spaces (one choice); q1, tests and docs (multiple choices). Then confirm the chosen answers. Do not modify files.",
    };
  return scenario;
}
