import { PublicToolError } from "@ace/mcp-server";
import type { ScreenAction } from "@ace/protocol";

export interface ModelCoordinates {
  owner: string;
  epoch: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}
/** v1 receives original capture pixels. MCP receives pixels from the emitted model image. */
export function legacyModelAction(
  session: {
    modelCoordinates: ModelCoordinates | undefined;
    epoch: number;
    latest: { header: { width: number; height: number } } | undefined;
  },
  owner: string,
  action: ScreenAction,
): ScreenAction {
  if (action.kind !== "click" && action.kind !== "scroll") return action;
  const mapping = session.modelCoordinates;
  if (
    !mapping ||
    mapping.owner !== owner ||
    mapping.epoch !== session.epoch ||
    mapping.sourceWidth !== session.latest?.header.width ||
    mapping.sourceHeight !== session.latest.header.height
  )
    throw new PublicToolError("screenshot_required");
  return {
    ...action,
    x: (action.x * mapping.sourceWidth) / mapping.width,
    y: (action.y * mapping.sourceHeight) / mapping.height,
  };
}
