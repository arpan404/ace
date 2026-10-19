import type { BrowserInput } from "@ace/protocol";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { keyEvent } from "./keyboard.ts";
import type { TouchPinch } from "./touch-pinch.ts";
type MouseInput = Extract<BrowserInput, { kind: "mouse" }>;
type TouchInput = Extract<BrowserInput, { kind: "touch" }>;
const PageScale = z.object({ cssVisualViewport: z.object({ scale: z.number().positive() }) });

/**
 * Chromium doesn't zoom for injected two-finger touches (nor for a synthesized pinch while
 * they are held): the page's scale follows the fingers' spread from where the pinch began.
 */
async function pinchStep(
  input: TouchInput,
  cdp: BrowserCdp,
  check: () => void,
  pinch: TouchPinch | undefined,
): Promise<void> {
  const zoom = pinch?.next(input);
  if (!pinch || zoom === undefined) return;
  if (pinch.base === undefined) {
    check();
    pinch.base = PageScale.parse(await cdp.send("Page.getLayoutMetrics")).cssVisualViewport.scale;
  }
  check();
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: pinch.base * zoom });
}

/** Without a held-buttons mask from the client: the one button named, none once released. */
function heldButtons(input: MouseInput): number {
  if (input.event === "mouseReleased" || input.button === "none") return 0;
  return input.button === "left" ? 1 : input.button === "right" ? 2 : 4;
}

/**
 * The lease is checked immediately before each dispatched effect. `pinch` follows the tab's
 * touch sequence, so two spreading fingers zoom the page as they would on a phone.
 */
export async function sendHumanInput(
  input: Exclude<BrowserInput, { kind: "pick" }>,
  cdp: BrowserCdp,
  check: () => void,
  pinch?: TouchPinch,
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
    case "ime":
      await cdp.send("Input.imeSetComposition", {
        text: input.text,
        selectionStart: Math.min(input.selectionStart, input.text.length),
        selectionEnd: Math.min(input.selectionEnd, input.text.length),
      });
      break;
    case "touch":
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      check();
      await cdp.send("Input.dispatchTouchEvent", {
        type: input.event,
        touchPoints: input.points,
      });
      await pinchStep(input, cdp, check, pinch);
      break;
  }
}
