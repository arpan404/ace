import type { BrowserInput } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";
import { keyEvent } from "./keyboard.ts";
type MouseInput = Extract<BrowserInput, { kind: "mouse" }>;

/** Without a held-buttons mask from the client: the one button named, none once released. */
function heldButtons(input: MouseInput): number {
  if (input.event === "mouseReleased" || input.button === "none") return 0;
  return input.button === "left" ? 1 : input.button === "right" ? 2 : 4;
}

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
        buttons: input.buttons ?? heldButtons(input),
        clickCount: input.clickCount,
        modifiers: input.modifiers,
      });
      break;
    case "scroll":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
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
