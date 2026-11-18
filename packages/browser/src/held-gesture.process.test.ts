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
  tabs: z.array(
    z.object({
      tabId: z.string(),
      url: z.string(),
      current: z.boolean().optional(),
      pending_dialog: z.object({ dialogId: z.string() }).optional(),
    }),
  ),
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The thread's tabs as an agent lists them. */
async function tabs(f: Fixture) {
  return Tabs.parse(await f.service.execute("thread", { action: "tabs", operation: "list" }, agent))
    .tabs;
}

/** The dialog `tabId`'s page raised, once the browser reports it. */
async function dialogIn(f: Fixture, tabId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const raised = (await tabs(f)).find((each) => each.tabId === tabId)?.pending_dialog;
    if (raised) return raised.dialogId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no dialog");
}

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

  it("answers a dialog on the page it checked, and the dialog closes", async () => {
    const f = await fixture();
    await f.navigate();
    const listed = await tabs(f);
    const here = listed.find((each) => each.current) ?? listed[0];
    if (!here) throw new Error("no tab");
    for (const kind of ["alert", "confirm"]) {
      await f.service.execute(
        "thread",
        {
          action: "evaluate",
          expression: `setTimeout(() => { window.answered = ${kind}("Sure?"); }, 0); true`,
        },
        person,
      );
      const dialogId = await dialogIn(f, here.tabId);
      await f.service.execute(
        "thread",
        {
          action: "dialog",
          dialogId,
          accept: true,
          expect: { tabId: here.tabId, url: here.url },
        },
        agent,
      );
      expect((await tabs(f)).find((each) => each.tabId === here.tabId)?.pending_dialog).toBe(
        undefined,
      );
      const answered = await f.service.execute(
        "thread",
        { action: "evaluate", expression: "String(window.answered)" },
        person,
      );
      expect(answered).toBe(kind === "confirm" ? "true" : "undefined");
    }
  });

  it("refuses an answer whose dialog was raised at another place or in another tab", async () => {
    const f = await fixture();
    await f.navigate();
    const listed = await tabs(f);
    const first = listed.find((each) => each.current) ?? listed[0];
    if (!first) throw new Error("no tab");
    const evaluate = (expression: string, tabId?: string) =>
      f.service.execute(
        "thread",
        { action: "evaluate", expression, ...(tabId ? { tabId } : {}) },
        person,
      );
    // The page routes to /checkout, then asks to confirm a payment there.
    await evaluate(
      `setTimeout(() => { history.pushState(null, "", "/checkout"); confirm("Pay?"); }, 0); true`,
    );
    const moved = await dialogIn(f, first.tabId);
    const checkedAt = { tabId: first.tabId, url: first.url };
    await expect(
      f.service.execute(
        "thread",
        { action: "dialog", dialogId: moved, accept: true, expect: checkedAt },
        agent,
      ),
    ).rejects.toMatchObject({ code: "place_changed" });
    expect((await tabs(f)).find((each) => each.tabId === first.tabId)?.pending_dialog).toEqual({
      dialogId: moved,
    });
    await f.service.execute("thread", { action: "dialog", dialogId: moved, accept: false }, person);
    // Another tab raises one: an answer checked against the first tab is refused there too.
    await f.service.execute("thread", { action: "tabs", operation: "open", url: first.url }, agent);
    const other = (await tabs(f)).find((each) => each.tabId !== first.tabId);
    if (!other) throw new Error("no second tab");
    await evaluate(`setTimeout(() => confirm("Delete?"), 0); true`, other.tabId);
    const elsewhere = await dialogIn(f, other.tabId);
    await expect(
      f.service.execute(
        "thread",
        { action: "dialog", dialogId: elsewhere, accept: true, expect: checkedAt },
        agent,
      ),
    ).rejects.toMatchObject({ code: "place_changed" });
    expect((await tabs(f)).find((each) => each.tabId === other.tabId)?.pending_dialog).toEqual({
      dialogId: elsewhere,
    });
    await f.service.execute(
      "thread",
      { action: "dialog", dialogId: elsewhere, accept: false },
      person,
    );
  });
});
