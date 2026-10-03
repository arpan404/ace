import { ConductorPlan, ConductorReview } from "@ace/protocol";
export function plan(graph: Record<string, string[]> = { a: [] }) {
  return ConductorPlan.parse({
    summary: "Scripted card plan",
    workstreams: Object.entries(graph).map(([id, dependencies]) => ({
      id,
      title: `Build ${id}`,
      dependencies,
      priority: 0,
      brief: {
        objective: `Build ${id}`,
        instructions: "Implement the card",
        acceptance: [`${id} works`],
        files: [`${id}.txt`],
        packages: [],
        risks: [],
      },
    })),
  });
}
export function review(id: string) {
  return ConductorReview.parse({
    verdict: "pass",
    summary: "Scripted review",
    requirements: [
      { criterion: `${id} works`, passed: true, evidence: "Synthetic provider evidence" },
    ],
    probes: ["Synthetic provider evidence"],
    mutations: Array.from({ length: 15 }, (_, index) => ({
      change: `Synthetic mutation ${index}`,
      caught: true,
      evidence: "Synthetic provider evidence",
    })),
    flakiness: { runs: 2, passed: true, evidence: "Synthetic provider evidence" },
    design: { passed: true, evidence: "Synthetic provider evidence" },
    performance: { passed: true, evidence: "Synthetic provider evidence" },
  });
}
