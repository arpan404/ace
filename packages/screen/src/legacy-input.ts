import type { ScreenAction } from "@ace/protocol";
import type { Session } from "./session.ts";

/** Preserve the viewer's original-pixel contract; MCP normalizes before entering this shell. */
export async function dispatchLegacyAction(
  session: Session,
  action: ScreenAction,
  beforeDispatch: () => void,
) {
  beforeDispatch();
  if (!session.helper.capabilities?.platform.startsWith("linux"))
    return session.helper.request({ op: "action", action });
  const scale = session.latest?.header.scale ?? 1;
  switch (action.kind) {
    case "click":
      return session.helper.requestV2({
        op: "pointer.click",
        x: action.x / scale,
        y: action.y / scale,
        button: action.button,
      });
    case "type":
      return session.helper.requestV2({ op: "text.type", text: action.text });
    case "scroll":
      await session.helper.requestV2({
        op: "pointer.move",
        x: action.x / scale,
        y: action.y / scale,
      });
      beforeDispatch();
      return session.helper.requestV2({ op: "scroll", dx: action.deltaX, dy: action.deltaY });
    case "key":
      throw new Error("Use a named key on protocol v2 helpers");
  }
}
