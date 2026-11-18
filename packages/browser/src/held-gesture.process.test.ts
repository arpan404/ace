import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "./session-options.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

/*
 * A held click (ADR 0171 amendment 3) whose press moves the page, in ace's own Chromium: the
 * press's mousedown handler routes the page to /checkout and draws a Pay button there. A real
 * browser is the only proof that the new page's handlers never see the release.
 */
const agent: Actor = { kind: "agent", agentId: "agent" };
const person: Actor = { kind: "human", connectionId: "person" };
const Tabs = z.object({
  tabs: z.array(z.object({ tabId: z.string(), url: z.string(), current: z.boolean().optional() })),
});

describe.skipIf(!executablePath)("a held click whose press moves the page", () => {
  it("never lets the new page see its release or a click, and leaves no button pressed", async () => {
    const f = await fixture();
    await f.navigate();
    const run = (expression: string) =>
      f.service.execute("thread", { action: "evaluate", expression }, person);
    await run(`
      window.hits = [];
      document.body.innerHTML = '<button id="go" style="width:160px;height:60px">Go</button>';
      document.getElementById("go").addEventListener("mousedown", () => {
        history.pushState(null, "", "/checkout");
        document.body.innerHTML = '<button id="pay" style="width:160px;height:60px">Pay</button>';
        const pay = document.getElementById("pay");
        for (const type of ["mouseup", "pointerup", "click"])
          pay.addEventListener(type, () => hits.push(type));
        for (const type of ["mousedown", "mousemove"])
          pay.addEventListener(type, (event) => hits.push(type + ":" + event.buttons));
      });
      true`);
    const snapshot = await f.service.execute("thread", { action: "snapshot" }, agent);
    const listed = Tabs.parse(
      await f.service.execute("thread", { action: "tabs", operation: "list" }, agent),
    );
    const here = listed.tabs.find((each) => each.current) ?? listed.tabs[0];
    if (!here) throw new Error("no tab");
    await expect(
      f.service.execute(
        "thread",
        {
          action: "click",
          ref: ref(snapshot, "Go"),
          expect: { tabId: here.tabId, url: here.url },
        },
        agent,
      ),
    ).rejects.toMatchObject({ code: "place_changed" });
    // The route changed, and nothing of the gesture reached the checkout page.
    expect(await run("location.pathname")).toBe("/checkout");
    expect(await run("JSON.stringify(hits)")).toBe("[]");
    // The next step is an ordinary click on Pay: it lands once, with no button held over.
    await run("hits = []; true");
    const next = await f.service.execute("thread", { action: "snapshot" }, agent);
    await f.service.execute("thread", { action: "click", ref: ref(next, "Pay") }, agent);
    const hits: unknown = JSON.parse(String(await run("JSON.stringify(hits)")));
    const pressed = z.array(z.string()).parse(hits);
    expect(pressed.filter((hit) => hit.startsWith("mousedown"))).toEqual(["mousedown:1"]);
    expect(pressed.filter((hit) => !hit.includes(":"))).toEqual(["pointerup", "mouseup", "click"]);
    // Every move before the press saw no button down.
    for (const move of pressed.filter((hit) => hit.startsWith("mousemove")))
      expect(move).toBe("mousemove:0");
  });
});
