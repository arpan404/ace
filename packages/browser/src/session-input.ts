import type { BrowserInput } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";
import { keyEvent } from "./keyboard.ts";
/** The lease is checked immediately before each dispatched effect. */
export async function sendHumanInput(
  input: BrowserInput,
  cdp: BrowserCdp,
  check: () => void,
): Promise<void> {
  check();
  switch (input.kind) {
    case "mouse":
      await cdp.send("Input.dispatchMouseEvent", {
        type: input.event,
        x: input.x,
        y: input.y,
        button: input.button,
        buttons:
          input.event === "mouseReleased" || input.button === "none"
            ? 0
            : input.button === "left"
              ? 1
              : input.button === "right"
                ? 2
                : 4,
        clickCount: input.clickCount,
      });
      break;
    case "scroll":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      });
      break;
    case "key":
      if (input.event === "char")
        await cdp.send("Input.insertText", { text: input.text ?? input.key });
      else await cdp.send("Input.dispatchKeyEvent", keyEvent(input));
      break;
    case "touch":
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      check();
      await cdp.send("Input.dispatchTouchEvent", {
        type: input.event,
        touchPoints: input.points,
      });
      break;
  }
}
