import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrowserPageState } from "@ace/protocol";
import { executablePath, fixture } from "./test-support.ts";

const Box = z.object({ x: z.number(), y: z.number() });

/** A person viewing the fixture's /interaction page, with each tab's latest page state. */
async function viewer() {
  const f = await fixture();
  await f.execute({ action: "navigate", url: `${f.url}/interaction` });
  let page: BrowserPageState = {};
  f.service.subscribe(
    "thread",
    "person",
    { send: () => true },
    () => {},
    (event) => {
      if (event.type === "browser.page") page = event.page;
    },
  );
  const input = (raw: unknown) => f.service.input("thread", raw, "person");
  const centre = async (id: string) =>
    Box.parse(
      await f.evaluate(
        `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: Math.round(r.left + Math.min(20, r.width / 2)), y: Math.round(r.top + r.height / 2) }; })()`,
      ),
    );
  const move = async (id: string) => {
    const at = await centre(id);
    await input({ kind: "mouse", event: "mouseMoved", ...at, button: "none" });
    return at;
  };
  const click = async (id: string) => {
    const at = await move(id);
    for (const event of ["mousePressed", "mouseReleased"])
      await input({ kind: "mouse", event, ...at, button: "left", clickCount: 1 });
  };
  const value = (id: string) => f.evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
  const log = () =>
    f.evaluate(`[...document.querySelectorAll("#log li")].map((li) => li.textContent)`);
  return { f, state: () => page, input, move, click, value, log };
}

describe.skipIf(!executablePath)("remote view page state", () => {
  it("reports the cursor shape over links and text, and a title tooltip after a rest", async () => {
    const v = await viewer();
    await v.move("link");
    await expect.poll(() => v.state().cursor, { timeout: 5_000 }).toBe("pointer");
    await v.move("prose");
    await expect.poll(() => v.state().cursor, { timeout: 5_000 }).toBe("text");
    await v.move("tip");
    await expect
      .poll(() => v.state().tooltip?.text, { timeout: 5_000 })
      .toBe("Saved two minutes ago");
    await v.move("link");
    await expect.poll(() => v.state().tooltip, { timeout: 5_000 }).toBe(undefined);
  }, 60_000);

  it("opens ace's picker for a select and sets the chosen option with the page's events", async () => {
    const v = await viewer();
    await v.click("colour");
    await expect.poll(() => v.state().picker?.kind, { timeout: 5_000 }).toBe("select");
    const picker = v.state().picker;
    expect(picker?.value).toBe("red");
    expect(picker?.options).toEqual([
      { value: "red", label: "Red", group: "Warm" },
      { value: "blue", label: "Blue" },
    ]);
    await v.input({ kind: "pick", pickerId: picker?.pickerId, values: ["blue"] });
    expect(await v.value("colour")).toBe("blue");
    expect(await v.log()).toEqual(["colour:input:blue", "colour:change:blue"]);
    expect(v.state().picker).toBe(undefined);
    // A choice for a picker that has closed changes nothing.
    await expect(
      v.input({ kind: "pick", pickerId: picker?.pickerId, values: ["red"] }),
    ).rejects.toThrow("no longer open");
    expect(await v.value("colour")).toBe("blue");
  }, 60_000);

  it("sets a date and a colour through ace's pickers", async () => {
    const v = await viewer();
    await v.click("day");
    await expect.poll(() => v.state().picker?.kind, { timeout: 5_000 }).toBe("date");
    expect(v.state().picker).toMatchObject({ value: "2026-03-04", min: "2026-01-01" });
    await v.input({ kind: "pick", pickerId: v.state().picker?.pickerId, values: ["2026-05-06"] });
    expect(await v.value("day")).toBe("2026-05-06");
    await v.click("shade");
    await expect.poll(() => v.state().picker?.kind, { timeout: 5_000 }).toBe("color");
    await v.input({ kind: "pick", pickerId: v.state().picker?.pickerId, values: ["#00ff00"] });
    expect(await v.value("shade")).toBe("#00ff00");
    expect(await v.log()).toEqual([
      "day:input:2026-05-06",
      "day:change:2026-05-06",
      "shade:input:#00ff00",
      "shade:change:#00ff00",
    ]);
  }, 60_000);

  it("dismissing a picker leaves the value and fires nothing", async () => {
    const v = await viewer();
    await v.click("colour");
    await expect.poll(() => v.state().picker?.kind, { timeout: 5_000 }).toBe("select");
    await v.input({ kind: "pick", pickerId: v.state().picker?.pickerId });
    expect(v.state().picker).toBe(undefined);
    expect(await v.value("colour")).toBe("red");
    expect(await v.log()).toEqual([]);
  }, 60_000);

  it("reports the focused field's type and lets IME composition commit into it", async () => {
    const v = await viewer();
    await v.click("email");
    await expect.poll(() => v.state().focus?.type, { timeout: 5_000 }).toBe("email");
    await v.click("notes");
    await expect.poll(() => v.state().focus?.type, { timeout: 5_000 }).toBe("textarea");
    await v.input({ kind: "ime", text: "に", selectionStart: 1, selectionEnd: 1 });
    await v.input({ kind: "ime", text: "にほん", selectionStart: 3, selectionEnd: 3 });
    expect(await v.value("notes")).toBe("にほん");
    await v.input({ kind: "key", event: "char", key: "Unidentified", text: "日本" });
    expect(await v.value("notes")).toBe("日本");
    await v.click("prose");
    await expect.poll(() => v.state().focus, { timeout: 5_000 }).toBe(undefined);
  }, 60_000);

  it("a new viewer starts from the page state already reported", async () => {
    const v = await viewer();
    await v.click("email");
    await expect.poll(() => v.state().focus?.type, { timeout: 5_000 }).toBe("email");
    const seen: BrowserPageState[] = [];
    v.f.service.subscribe(
      "thread",
      "second",
      { send: () => true },
      () => {},
      (event) => {
        if (event.type === "browser.page") seen.push(event.page);
      },
    );
    expect(seen.at(-1)?.focus?.type).toBe("email");
  }, 60_000);
});
