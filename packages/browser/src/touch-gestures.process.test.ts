import { describe, expect, it } from "vitest";
import { executablePath, fixture } from "./test-support.ts";

const owner = { kind: "human", connectionId: "owner" } as const;

/** A person on a touch screen, with the fixture's tall page open at a phone's size. */
async function touchPage() {
  const f = await fixture();
  await f.navigate();
  await f.service.execute(
    "thread",
    { action: "resize", width: 390, height: 700, touch: true },
    owner,
  );
  const evaluate = (expression: string) =>
    f.service.execute("thread", { action: "evaluate", expression }, owner);
  const touch = (event: string, points: { x: number; y: number; id: number }[]) =>
    f.service.input("thread", { kind: "touch", event, points }, "owner");
  /** Polls the page until `expression` is truthy (gestures settle after their input returns). */
  const until = async (expression: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate(expression)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  return { f, evaluate, touch, until };
}

describe.skipIf(!executablePath)("the person's touches in ace's headless Chrome", () => {
  it("lays the page out as a touch screen after a touch-screen resize", async () => {
    const { evaluate } = await touchPage();
    expect(await evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
    expect(await evaluate("navigator.maxTouchPoints > 0")).toBe(true);
  }, 60_000);

  it("a tap clicks the element under the finger", async () => {
    const { evaluate, touch, until } = await touchPage();
    const box = await evaluate(
      "(()=>{window.tapped=[];const b=document.querySelector('button');b.addEventListener('click',()=>tapped.push('click'));const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
    );
    if (typeof box !== "object" || box === null || !("x" in box) || !("y" in box))
      throw new Error("Missing button box");
    const at = { x: Number(box.x), y: Number(box.y), id: 0 };
    await touch("touchStart", [at]);
    await touch("touchEnd", []);
    expect(await until("tapped.length === 1")).toBe(true);
  }, 60_000);

  it("a one-finger drag scrolls the page", async () => {
    const { evaluate, touch, until } = await touchPage();
    expect(await evaluate("scrollY")).toBe(0);
    await touch("touchStart", [{ x: 200, y: 600, id: 0 }]);
    for (let y = 560; y >= 160; y -= 40) await touch("touchMove", [{ x: 200, y, id: 0 }]);
    await touch("touchEnd", []);
    expect(await until("scrollY > 100")).toBe(true);
  }, 60_000);

  it("a two-finger pinch zooms the page", async () => {
    const { evaluate, touch, until } = await touchPage();
    const before = Number(await evaluate("visualViewport.scale"));
    await touch("touchStart", [{ x: 180, y: 350, id: 0 }]);
    await touch("touchStart", [
      { x: 180, y: 350, id: 0 },
      { x: 210, y: 350, id: 1 },
    ]);
    for (let step = 1; step <= 10; step++)
      await touch("touchMove", [
        { x: 180 - step * 12, y: 350, id: 0 },
        { x: 210 + step * 12, y: 350, id: 1 },
      ]);
    await touch("touchEnd", []);
    expect(await until(`visualViewport.scale > ${before * 1.2}`)).toBe(true);
  }, 60_000);
});
