import { expect, it } from "vitest";
import { buildTriagePrompt, triageInvocation } from "@ace/diagnostics/triage";
it("a performance handoff preserves the description and distinguishes measurements from provider latency", () => {
  const prompt = buildTriagePrompt({
    kind: "performance",
    description: "Switching threads takes 4 seconds",
    report: {
      at: 123,
      checks: [{ id: "git", status: "fail", message: "Git missing", fix: "Install Git" }],
    },
  });
  expect(prompt).toContain("Switching threads takes 4 seconds");
  expect(prompt).toContain("measure the affected path");
  expect(prompt).toContain("Git missing");
  expect(prompt).toContain("Install Git");
  expect(prompt).toContain("ask the user before publishing");
});
it("a feature handoff asks for acceptance criteria and does not use the bug investigation workflow", () => {
  const prompt = buildTriagePrompt({ kind: "feature", description: "Add grouped notifications" });
  expect(prompt).toContain("acceptance criteria");
  expect(prompt).toContain("Add grouped notifications");
  expect(prompt).not.toContain("reproduction steps");
  expect(() => buildTriagePrompt({ kind: "bug", description: "  " })).toThrow();
});
it.each(["claude", "codex", "cursor"] as const)(
  "%s receives prompt metacharacters as one positional argument",
  (provider) => {
    const prompt = '--model strange; $(touch /tmp/never)\n"quoted"';
    expect(triageInvocation(provider, prompt).args).toEqual(["--", prompt]);
  },
);
