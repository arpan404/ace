import { z } from "zod";
import { cursorSdkScenarios } from "./cursor-sdk-scenarios.ts";

export const CursorSdkScenario = z.enum(cursorSdkScenarios.map((scenario) => scenario.id));
export const CursorSdkApproval = z.strictObject({
  scenario: CursorSdkScenario,
  approved: z.literal(true),
});
export function cursorSdkPlan(approval: unknown) {
  const { scenario } = CursorSdkApproval.parse(approval);
  const spec = cursorSdkScenarios.find((value) => value.id === scenario);
  if (!spec) throw new Error("Unknown approved SDK scenario");
  return {
    ...spec,
    policy: scenario === "full-access" ? ("full-access" as const) : ("restricted" as const),
    requiresMcp: scenario === "restricted-mcp" || scenario === "mcp-image",
    workflow:
      scenario === "interrupt-work"
        ? ("interrupt" as const)
        : scenario === "steering-restart"
          ? ("steer" as const)
          : scenario === "checkpoint-resume"
            ? ("resume" as const)
            : scenario === "portable-fork"
              ? ("fork" as const)
              : scenario === "background-child"
                ? ("background-followup" as const)
                : ("turn" as const),
  };
}
