import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")("toast screenshot", async () => {
  const out = process.env.SHOT_OUT ?? "/tmp/toast.png";
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
    const view = nativePage(s.app, p, s.url);
    await expect.poll(view.placed, { timeout: 30000 }).toBe(true);
    await s.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w?.setBounds({ x: 40, y: 40, width: 1400, height: 900 });
      w?.show();
      w?.focus();
      w?.webContents.send("ace:event:updates.status", {
        state: "available",
        version: "9.9.9",
        url: "https://example.com",
      });
    });
    await p.getByText("ace 9.9.9 is available").waitFor();
    await new Promise((r) => setTimeout(r, 1500));
    const g = await view.geometry();
    console.log("SHOT", out, JSON.stringify({ nativeVisible: g.native.visible }));
    const id = await s.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getMediaSourceId(),
    );
    const windowId = id?.split(":")[1];
    if (!windowId) throw new Error("no window id");
    execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, out]);
  } finally {
    await s.close();
  }
});
