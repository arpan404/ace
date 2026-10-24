import { z } from "zod";
import { expect, it } from "vitest";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

const phone = { kind: "human", connectionId: "phone" } as const;

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "a phone watching the desktop's tab gets a phone page, its taps land, and the panel's comes back",
  async () => {
    const s = await browserSandbox();
    try {
      const p = s.page;
      await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
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
        .toBe("embedded");
      const view = nativePage(s.app, p, s.url);
      await expect.poll(view.placed, { timeout: 30000 }).toBe(true);
      const layout = () =>
        view.read(
          "[innerWidth, navigator.userAgent.includes('Android'), navigator.maxTouchPoints > 0]",
        );
      const panelWidth = z.number().parse(await view.read("innerWidth"));
      expect(panelWidth).toBeGreaterThan(390);
      expect(await layout()).toEqual([panelWidth, false, false]);

      // The phone sizes the tab the desktop panel shows.
      await s.daemon.browser.execute(
        s.thread.id,
        { action: "resize", width: 390, height: 700, touch: true, devicePixelRatio: 3 },
        phone,
      );
      await expect.poll(layout, { timeout: 10000 }).toEqual([390, true, true]);
      // The view takes the phone's shape inside the panel: its picture is the phone page only.
      const { box, native } = await view.geometry();
      if (!box) throw new Error("Panel missing");
      expect(native.visible).toBe(true);
      expect(native.bounds.width / native.bounds.height).toBeCloseTo(390 / 700, 1);
      expect(native.bounds.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(native.bounds.x + native.bounds.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(native.bounds.height).toBeLessThanOrEqual(box.height + 1);
      const tabs = s.daemon.browser.state(s.thread.id)?.tabs;
      expect(tabs?.[0]).toMatchObject({ tabId: expect.any(String) });

      // A tap in the phone page's CSS pixels lands on the button there.
      const target = z
        .object({ x: z.number(), y: z.number() })
        .parse(
          await view.read(
            "(()=>{const r=document.querySelector('#click').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
          ),
        );
      const points = [{ ...target, id: 0 }];
      await s.daemon.browser.input(
        s.thread.id,
        { kind: "touch", event: "touchStart", points },
        "phone",
      );
      await s.daemon.browser.input(
        s.thread.id,
        { kind: "touch", event: "touchEnd", points: [] },
        "phone",
      );
      await expect.poll(() => view.read("window.clicks"), { timeout: 10000 }).toBe(1);

      // The phone leaves: the panel's own layout comes back.
      s.daemon.browser.disconnect("phone");
      await expect.poll(layout, { timeout: 10000 }).toEqual([panelWidth, false, false]);
      await expect.poll(view.placed, { timeout: 10000 }).toBe(true);
    } finally {
      await s.close();
    }
  },
);
