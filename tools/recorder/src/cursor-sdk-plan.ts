import { z } from "zod";
import { cursorSdkScenarios } from "./cursor-sdk-scenarios.ts";

export const CursorSdkScenario = z.enum(cursorSdkScenarios.map((scenario) => scenario.id));
export const CursorSdkApproval = z.strictObject({
  scenario: CursorSdkScenario,
  approved: z.literal(true),
});
export const CursorSdkRecordingPolicy = z.enum(["scenario-policy", "full-access"]);
export function cursorSdkPlan(
  approval: unknown,
  recordingPolicy: z.infer<typeof CursorSdkRecordingPolicy> = "scenario-policy",
) {
  const { scenario } = CursorSdkApproval.parse(approval);
  CursorSdkRecordingPolicy.parse(recordingPolicy);
  const spec = cursorSdkScenarios.find((value) => value.id === scenario);
  if (!spec) throw new Error("Unknown approved SDK scenario");
  const requiresMcp = scenario === "restricted-mcp" || scenario === "mcp-image";
  if (requiresMcp && recordingPolicy === "full-access")
    throw new Error("The behavioural full-access override does not authorize MCP scenarios");
  return {
    ...spec,
    recordingPolicy,
    policy:
      recordingPolicy === "full-access" || scenario === "full-access"
        ? ("full-access" as const)
        : ("restricted" as const),
    requiresMcp,
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
