import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { z } from "zod";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "web fallback resizes its viewport, accepts complete key events, and keeps page controls working",
  async () => {
    const s = await browserSandbox("headless");
    const browser = await chromium.launch({ executablePath: s.executablePath });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      });
      const p = await context.newPage();
      const token = (await readFile(s.daemon.tokenPath, "utf8")).trim();
      await p.goto(
        `${s.web.origin}/t/${s.thread.id}#${new URLSearchParams({ token, daemon: s.daemon.url })}`,
      );
      await p.getByRole("heading", { level: 1 }).first().waitFor();
      const address = p.getByRole("combobox", { name: "Address" });
      await expect
        .poll(
          async () => {
            if (await address.isVisible()) return true;
            await p.keyboard.press("Control+Shift+B");
            return false;
          },
          { timeout: 30000, interval: 1000 },
        )
        .toBe(true);
      await address.fill(s.url);
      await address.press("Enter");
      await expect
        .poll(() => s.daemon.browser.state(s.thread.id)?.backend, { timeout: 30000 })
        .toBe("headless");
      const pane = p.getByRole("application", { name: `Control ${s.url}` });
      await pane.waitFor();
      const read = async (expression: string) =>
        s.daemon.browser.execute(
          s.thread.id,
          { action: "evaluate", expression },
          { kind: "human", connectionId: "person" },
        );
      await expect
        .poll(
          async () => {
            const box = await pane.boundingBox();
            const size = z
              .object({ width: z.number(), height: z.number() })
              .parse(await read("({width:innerWidth,height:innerHeight})"));
            return (
              !!box &&
              Math.abs(size.width - box.width) < 2 &&
              Math.abs(size.height - box.height) < 2
            );
          },
          { timeout: 30000 },
        )
        .toBe(true);
      const input = z
        .object({ x: z.number(), y: z.number() })
        .parse(
          await read(
            "(()=>{const r=document.querySelector('#name').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
          ),
        );
      // The live picture (decoded video) fills the pane at the page's own size; video frames
      // are a few pixels smaller where the encoder rounds the size down to its block size.
      const picture = pane.getByRole("img", { name: `Live view of ${s.url}` });
      await expect
        .poll(
          async () => {
            const box = await pane.boundingBox();
            const drawn = await picture.boundingBox();
            return (
              !!box &&
              !!drawn &&
              Math.abs(drawn.width - box.width) < 8 &&
              Math.abs(drawn.height - box.height) < 8
            );
          },
          { timeout: 30000 },
        )
        .toBe(true);
      const marker = z
        .object({ x: z.number(), y: z.number() })
        .parse(
          await read(
            "(()=>{const r=document.querySelector('#click').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
          ),
        );
      const paneBox = await pane.boundingBox();
      if (!paneBox) throw new Error("Fallback pane missing");
      await p.mouse.move(paneBox.x + marker.x, paneBox.y + marker.y);
      await expect.poll(() => read("window.hovered")).toBe(true);
      await pane.click({ position: input });
      await p.keyboard.type("abc");
      await expect.poll(() => read("document.querySelector('#name').value")).toBe("abc");
      await p.keyboard.press("ControlOrMeta+A");
      await p.keyboard.type("x");
      await expect.poll(() => read("document.querySelector('#name').value")).toBe("x");
      await p.keyboard.press("ControlOrMeta+K");
      await p.getByRole("dialog").waitFor();
      await p.keyboard.press("Escape");
      await p.setViewportSize({ width: 1240, height: 780 });
      await expect
        .poll(async () => {
          const box = await pane.boundingBox();
          const height = z.number().parse(await read("innerHeight"));
          return !!box && Math.abs(height - box.height) < 2;
        })
        .toBe(true);
      // A new browser tab's address opens a page of its own; closing the tab closes it.
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "New browser tab" }).click();
      await address.fill(new URL("/second", s.url).href);
      await address.press("Enter");
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.tabs?.length).toBe(2);
      await p.keyboard.press("ControlOrMeta+Alt+w");
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.tabs?.length).toBe(1);
      await pane.waitFor();
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "Find in page" }).click();
      await p.getByRole("textbox", { name: "Find text" }).fill("Fixture needle");
      await p.getByText("Match found", { exact: true }).waitFor();
    } finally {
      await browser.close();
      await s.close();
    }
  },
  240000,
);
