import { describe, expect, it } from "vitest";
import { executablePath, fixture } from "./test-support.ts";

const owner = { kind: "human", connectionId: "owner" } as const;

describe.skipIf(!executablePath)("the person's pointer input", () => {
  it("delivers held keys on clicks and wheels, and held buttons on drags", async () => {
    const f = await fixture();
    await f.navigate();
    const evaluate = (expression: string) =>
      f.service.execute("thread", { action: "evaluate", expression }, owner);
    await evaluate(
      "window.seen=[];for(const type of ['mousedown','mouseup','click','mousemove','wheel'])document.addEventListener(type,e=>seen.push({type,shift:e.shiftKey,ctrl:e.ctrlKey,alt:e.altKey,meta:e.metaKey,buttons:e.buttons}),{passive:true})",
    );
    const input = (raw: unknown) => f.service.input("thread", raw, "owner");

    // Shift-click: both halves and the click carry shift.
    for (const event of ["mousePressed", "mouseReleased"])
      await input({ kind: "mouse", event, x: 300, y: 300, button: "left", modifiers: 8 });
    // Alt+Meta wheel.
    await input({ kind: "scroll", x: 300, y: 300, deltaX: 0, deltaY: 10, modifiers: 1 | 4 });
    // A right-button drag: the move reports the right button held.
    await input({ kind: "mouse", event: "mousePressed", x: 300, y: 300, button: "right" });
    await input({
      kind: "mouse",
      event: "mouseMoved",
      x: 320,
      y: 320,
      button: "right",
      buttons: 2,
    });
    await input({ kind: "mouse", event: "mouseReleased", x: 320, y: 320, button: "right" });

    const seen = await evaluate("seen");
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mousedown", shift: true, ctrl: false }),
        expect.objectContaining({ type: "click", shift: true }),
        expect.objectContaining({ type: "wheel", alt: true, meta: true, shift: false }),
        expect.objectContaining({ type: "mousemove", buttons: 2, shift: false }),
      ]),
    );
  }, 60_000);

  it("keeps plain clicks plain when no keys are held", async () => {
    const f = await fixture();
    await f.navigate();
    const evaluate = (expression: string) =>
      f.service.execute("thread", { action: "evaluate", expression }, owner);
    await evaluate(
      "window.clicks=[];document.addEventListener('click',e=>clicks.push(e.shiftKey||e.ctrlKey||e.altKey||e.metaKey))",
    );
    for (const event of ["mousePressed", "mouseReleased"])
      await f.service.input("thread", { kind: "mouse", event, x: 300, y: 300 }, "owner");
    expect(await evaluate("clicks")).toEqual([false]);
  }, 60_000);
});
