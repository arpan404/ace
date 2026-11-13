import type { AgentPointerKind } from "@ace/protocol";

/*
 * What a screen_act batch means for cowork (ADR 0143): whether it acts on the app (so it waits
 * while the person uses it), and where the agent's pointer ends up, for viewers to draw.
 */

type Step = { type: string } & Record<string, unknown>;

/** Steps that only wait or look act on nothing, so a batch of only these never waits. */
const passive = new Set(["wait", "wait_for", "if"]);

export function actsOnApp(steps: readonly Step[]): boolean {
  return steps.some((step) => !passive.has(step.type));
}

const kinds: Record<string, AgentPointerKind> = {
  click: "click",
  move: "move",
  drag: "drag",
  scroll: "scroll",
  type: "type",
  paste: "type",
  key: "type",
  set_value: "type",
  select_text: "drag",
};

const pair = (value: unknown): { x: number; y: number } | undefined =>
  Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
    ? { x: value[0], y: value[1] }
    : undefined;

/**
 * The last step that put the agent's pointer at a known spot (screenshot pixels), with its
 * kind. Steps aimed at an outline id have no point here, so they leave it where it was.
 */
export function lastPoint(
  steps: readonly Step[],
): { point: { x: number; y: number }; kind: AgentPointerKind } | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (!step) continue;
    const kind = kinds[step.type];
    if (!kind) continue;
    const point =
      step.type === "drag"
        ? pair(step["to"])
        : typeof step["x"] === "number" && typeof step["y"] === "number"
          ? { x: step["x"], y: step["y"] }
          : undefined;
    if (point) return { point, kind };
  }
  return undefined;
}
