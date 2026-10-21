import { expect, it } from "vitest";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "picture-in-picture draws the page's live video inside its box, and a click brings the page back",
  async () => {
    const s = await browserSandbox();
    const agent = { kind: "agent" } as const;
    let working: ReturnType<typeof setInterval> | undefined;
    try {
      const p = s.page;
      const threadId = s.thread.id;
      await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
      await s.daemon.browser.open({
        threadId,
        workspaceId: s.thread.workspaceId,
        background: true,
      });
      await s.daemon.browser.execute(threadId, { action: "navigate", url: s.url }, agent);
      const native = nativePage(s.app, p, s.url);
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
      await expect.poll(native.placed, { timeout: 30000 }).toBe(true);
      // The agent keeps working in the page, so it follows the person out of the panel.
      working = setInterval(() => {
        void s.daemon.browser
          .execute(threadId, { action: "evaluate", expression: "1" }, agent)
          .catch(() => {});
      }, 1500);
      await p.getByRole("button", { name: "Right panel", exact: true }).click();
      const pip = p.getByRole("region", { name: /^Picture in picture/ });
      await pip.waitFor({ timeout: 20000 });
      // No native view in the window: it would paint over the app, past the box's edges.
      await expect.poll(async () => (await native.geometry()).native.visible).toBe(false);
      const picture = pip.getByRole("img", { name: `Live view of ${s.url}` });
      await picture.waitFor({ timeout: 20000 });
      const drawn = () =>
        picture.evaluate((element) => {
          if (!(element instanceof HTMLCanvasElement)) return { hash: 0, inside: false };
          const pixels =
            element.getContext("2d")?.getImageData(0, 0, element.width, element.height).data ?? [];
          let hash = 0;
          for (let i = 0; i < pixels.length; i += 4)
            hash = (hash * 31 + (pixels[i] ?? 0) + (pixels[i + 2] ?? 0) * 7) % 1_000_000_007;
          const box = element.getBoundingClientRect();
          const frame = element.closest("section")?.getBoundingClientRect();
          const inside =
            !!frame &&
            box.left >= frame.left &&
            box.top >= frame.top &&
            box.right <= frame.right &&
            box.bottom <= frame.bottom;
          return { hash, inside };
        });
      const first = await drawn();
      expect(first.inside).toBe(true);
      // The fixture animates every frame: the picture keeps moving.
      await expect.poll(async () => (await drawn()).hash, { timeout: 10000 }).not.toBe(first.hash);
      await picture.click();
      await expect.poll(() => pip.count(), { timeout: 10000 }).toBe(0);
      await expect.poll(native.placed, { timeout: 10000 }).toBe(true);
      // Only × puts it away.
      await p.getByRole("button", { name: "Right panel", exact: true }).click();
      await pip.waitFor({ timeout: 20000 });
      await p.getByRole("button", { name: "Close picture in picture" }).click();
      await expect.poll(() => pip.count()).toBe(0);
    } catch (error) {
      await s.page.screenshot({ path: "/tmp/ace-pip-ui.png" });
      throw error;
    } finally {
      clearInterval(working);
      await s.close();
    }
  },
  240000,
);
