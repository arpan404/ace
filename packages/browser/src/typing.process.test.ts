import { describe, expect, it } from "vitest";
import type { Actor } from "./session-options.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

/*
 * An agent typing and dragging in a tab the person works in (ADR 0067, "Sharing a tab
 * safely"). The person's input arrives the way a live viewer sends it.
 */
const agent: Actor = { kind: "agent", agentId: "agent" };
const person: Actor = { kind: "human", connectionId: "person" };
const timing = (quietMs: number) => ({
  quietMs,
  maxWaitMs: 10_000,
  inUseMs: 1_000,
  followAfterMs: 1_000,
  presentMs: 30_000,
});
const nudge = { kind: "mouse", event: "mouseMoved", x: 5, y: 5, button: "none" } as const;

async function page(quietMs: number, html: string, script = "") {
  const f = await fixture({ collaboration: timing(quietMs) });
  await f.navigate();
  await f.service.execute(
    "thread",
    {
      action: "evaluate",
      expression: `document.body.innerHTML = ${JSON.stringify(html)}; ${script}; true`,
    },
    person,
  );
  const snapshot = await f.service.execute("thread", { action: "snapshot" }, agent);
  const read = (expression: string) =>
    f.service.execute("thread", { action: "evaluate", expression }, person);
  return { f, snapshot, read };
}

describe.skipIf(!executablePath)("an agent typing beside the person", () => {
  it("keeps the person's text, focus and caret when an agent types while they work in the tab", async () => {
    const { f, snapshot, read } = await page(
      200,
      `<input aria-label="Name" id="name"><textarea aria-label="Notes" id="notes"></textarea>`,
    );
    // The person writes a note and leaves their caret after the first letter.
    await read("document.getElementById('notes').focus(); true");
    for (const key of ["h", "i"])
      await f.service.input("thread", { kind: "key", event: "char", key, text: key }, "person");
    await read("document.getElementById('notes').setSelectionRange(1, 1); true");

    expect(
      await f.service.execute(
        "thread",
        { action: "type", ref: ref(snapshot, "Name"), text: "Ada" },
        agent,
      ),
    ).toEqual({ ok: true });
    expect(await read("document.getElementById('name').value")).toBe("Ada");
    expect(await read("document.activeElement.id")).toBe("notes");
    expect(await read("document.getElementById('notes').selectionStart")).toBe(1);

    // Typing into the person's own field adds to their text instead of replacing it.
    expect(
      await f.service.execute(
        "thread",
        { action: "type", ref: ref(snapshot, "Notes"), text: " there" },
        agent,
      ),
    ).toMatchObject({ ok: true, kept_text: true });
    expect(await read("document.getElementById('notes').value")).toBe("hi there");
    expect(await read("document.activeElement.id")).toBe("notes");
    expect(await read("document.getElementById('notes').selectionStart")).toBe(1);
  }, 60_000);

  it("fill_form waits again for a person who comes back between two fields", async () => {
    const quietMs = 1_500;
    const { f, snapshot, read } = await page(
      quietMs,
      `<input aria-label="First" id="first"><input aria-label="Second" id="second">`,
      // The first field's own handler keeps the page busy long enough for the person to return.
      `window.filledAt = {};
       document.getElementById('first').addEventListener('input', () => {
         const until = Date.now() + 1000; while (Date.now() < until) {}
         filledAt.first = Date.now();
       });
       document.getElementById('second').addEventListener('input', () => { filledAt.second = Date.now(); });`,
    );
    const fill = f.service.execute(
      "thread",
      {
        action: "fill_form",
        fields: [
          { ref: ref(snapshot, "First"), value: "one" },
          { ref: ref(snapshot, "Second"), value: "two" },
        ],
      },
      agent,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const personAt = Date.now();
    await f.service.input("thread", nudge, "person");
    await fill;
    expect(await read("document.getElementById('second').value")).toBe("two");
    const second = Number(await read("filledAt.second"));
    expect(second - personAt).toBeGreaterThanOrEqual(quietMs - 150);
  }, 60_000);
});
