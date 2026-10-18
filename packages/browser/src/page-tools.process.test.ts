import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executablePath, fixture } from "./test-support.ts";

const person = { kind: "human", connectionId: "person" } as const;
const Tab = z.object({
  zoom: z.number().optional(),
  emulation: z
    .object({
      width: z.number(),
      height: z.number(),
      userAgent: z.string().optional(),
      by: z.enum(["human", "agent"]),
    })
    .optional(),
});
const tabOf = (state: unknown) =>
  Tab.parse(z.object({ tabs: z.array(z.unknown()).min(1) }).parse(state).tabs[0]);

describe.skipIf(!executablePath)("the person's page tools in ace's Chrome", () => {
  it("a device toolbar device reaches the page and the tab list; the pane's size puts it back", async () => {
    const f = await fixture();
    await f.navigate();
    const ownAgent = String(await f.evaluate("navigator.userAgent"));
    await f.service.execute(
      "thread",
      {
        action: "emulate",
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        userAgent: "ace-test-phone",
      },
      person,
    );
    // A mobile page without a viewport tag lays out at 980 CSS pixels, as on a phone.
    expect(
      await f.evaluate(
        "[screen.width, innerWidth, devicePixelRatio, navigator.userAgent, navigator.maxTouchPoints > 0, matchMedia('(pointer: coarse)').matches]",
      ),
    ).toEqual([390, 980, 3, "ace-test-phone", true, true]);
    expect(tabOf(f.service.state("thread")).emulation).toMatchObject({
      width: 390,
      height: 844,
      userAgent: "ace-test-phone",
      by: "human",
    });

    await f.service.execute("thread", { action: "resize", width: 800, height: 600 }, person);
    expect(await f.evaluate("[innerWidth, navigator.userAgent, navigator.maxTouchPoints]")).toEqual(
      [800, ownAgent, 0],
    );
    expect(tabOf(f.service.state("thread")).emulation).toBeUndefined();
  }, 60_000);

  it("an agent's resize is listed as the agent's size, for the person's view to follow", async () => {
    const f = await fixture();
    await f.navigate();
    await f.execute({ action: "resize", width: 500, height: 700 });
    expect(tabOf(f.service.state("thread")).emulation).toMatchObject({
      width: 500,
      height: 700,
      by: "agent",
    });
  }, 60_000);

  it("zoom scales the page like a browser's zoom and is kept through a resize", async () => {
    const f = await fixture();
    await f.navigate();
    await f.service.execute("thread", { action: "resize", width: 900, height: 600 }, person);
    const scale = z.number().parse(await f.evaluate("devicePixelRatio"));
    await f.service.execute("thread", { action: "zoom", factor: 1.5 }, person);
    expect(await f.evaluate("[innerWidth, devicePixelRatio]")).toEqual([600, scale * 1.5]);
    expect(tabOf(f.service.state("thread")).zoom).toBe(1.5);

    await f.service.execute("thread", { action: "resize", width: 600, height: 400 }, person);
    expect(await f.evaluate("innerWidth")).toBe(400);

    await f.service.execute("thread", { action: "zoom", factor: 1 }, person);
    expect(await f.evaluate("[innerWidth, devicePixelRatio]")).toEqual([600, scale]);
    expect(tabOf(f.service.state("thread")).zoom).toBeUndefined();
  }, 60_000);

  it("print to PDF saves a PDF of the page", async () => {
    const f = await fixture();
    await f.navigate();
    const pdf = z
      .object({ path: z.string(), mimeType: z.literal("application/pdf") })
      .parse(await f.service.execute("thread", { action: "pdf" }, person));
    expect((await readFile(pdf.path)).subarray(0, 5).toString()).toBe("%PDF-");
  }, 60_000);

  it("a person's screenshot comes back as a PNG they can copy, and is saved", async () => {
    const f = await fixture();
    await f.navigate();
    const shot = z
      .object({ path: z.string(), data: z.string() })
      .parse(await f.service.execute("thread", { action: "screenshot" }, person));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(Buffer.from(shot.data, "base64").subarray(0, 8)).toEqual(png);
    expect((await readFile(shot.path)).subarray(0, 8)).toEqual(png);
  }, 60_000);

  it("page source is the document as the server sent it", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("document.body.dataset.changed = 'live-only'");
    const source = z
      .object({ url: z.string(), source: z.string(), truncated: z.boolean() })
      .parse(await f.service.execute("thread", { action: "page_source" }, person));
    expect(source.url).toBe(`${f.url}/`);
    expect(source.source).toContain("console-marker");
    expect(source.source).not.toContain("live-only");
    expect(source.truncated).toBe(false);
  }, 60_000);

  it("clearing browsing data removes the site's cookies and storage", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("document.cookie = 'kept=1; max-age=3600'; localStorage.setItem('kept', '1')");
    expect(await f.evaluate("[document.cookie, localStorage.length]")).toEqual(["kept=1", 1]);
    await f.service.execute("thread", { action: "clear_data" }, person);
    expect(await f.evaluate("[document.cookie, localStorage.length]")).toEqual(["", 0]);
  }, 60_000);

  it("agents get none of the person's page tools", async () => {
    const f = await fixture();
    await f.navigate();
    for (const command of [
      { action: "zoom", factor: 2 },
      { action: "clear_data" },
      { action: "page_source" },
    ])
      await expect(f.execute(command)).rejects.toThrow();
    expect(tabOf(f.service.state("thread")).zoom).toBeUndefined();
  }, 60_000);
});
