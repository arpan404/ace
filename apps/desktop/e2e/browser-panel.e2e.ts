import { readFile } from "node:fs/promises";
import { z } from "zod";
import { expect, it } from "vitest";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "native browser follows panel geometry, exposes controls and isolates profiles",
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
      const pageView = nativePage(s.app, p, s.url);
      const geometry = pageView.geometry;
      await expect.poll(pageView.placed, { timeout: 30000 }).toBe(true);
      await address.fill("127.0.0.1");
      const suggestions = p.getByRole("listbox", { name: "Suggested addresses" });
      await suggestions.waitFor();
      const suggestionBox = await suggestions.boundingBox();
      const pageBox = await p.locator("[data-browser-page]").boundingBox();
      if (!suggestionBox || !pageBox) throw new Error("Suggestion geometry missing");
      await expect.poll(async () => (await geometry()).native?.visible).toBe(true);
      await address.press("ArrowDown");
      await p.getByRole("option", { selected: true }).waitFor();
      await address.press("Escape");
      await expect.poll(async () => (await geometry()).native?.visible).toBe(true);
      await p.getByRole("button", { name: "Browser options" }).click();
      await expect
        .poll(async () => {
          const native = (await geometry()).native;
          const menu = await p.getByRole("menu").boundingBox();
          return (
            !!native?.visible &&
            !!menu &&
            (native.bounds.y >= menu.y + menu.height ||
              native.bounds.x + native.bounds.width <= menu.x)
          );
        })
        .toBe(true);
      await p.keyboard.press("Escape");
      await expect.poll(async () => (await geometry()).native?.visible).toBe(true);
      await p.getByRole("button", { name: "Hide sidebar" }).click();
      await expect
        .poll(async () => {
          const { box, native } = await geometry();
          return !!box && Math.abs((native?.bounds.x ?? 0) - box.x) < 2;
        })
        .toBe(true);
      const nativeRead = pageView.read;
      expect(
        await nativeRead(
          "({root:typeof require,frame:typeof document.querySelector('iframe').contentWindow.require})",
        ),
      ).toEqual({ root: "undefined", frame: "undefined" });
      const click = async (selector: string) => {
        // Leave renderer tooltips and wait for the native surface before native input.
        await p.mouse.move(0, 0);
        await expect.poll(async () => (await geometry()).native?.visible).toBe(true);
        await pageView.personClicks(selector);
      };
      const exact = pageView.placed;
      await p.getByRole("button", { name: "Full view", exact: true }).click();
      await expect.poll(exact).toBe(true);
      await p.getByRole("button", { name: "Exit full view", exact: true }).click();
      await expect.poll(exact).toBe(true);
      // Hiding the side panel hides the native page with it; showing it lines the page up again.
      await p.getByRole("button", { name: "Right panel", exact: true }).click();
      await expect.poll(async () => (await geometry()).native?.visible ?? false).toBe(false);
      await p.getByRole("button", { name: "Right panel", exact: true }).click();
      await expect.poll(exact).toBe(true);
      // The page left the person's view with the panel, which ends a shared hold: the agent
      // drives again until the person takes over.
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.controller).toBe("agent");
      await p.getByRole("button", { name: "Take over", exact: true }).click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.controller).toBe("human");
      const resize = p.getByRole("separator", { name: "Resize thread panel" });
      const grip = await resize.boundingBox();
      if (!grip) throw new Error("Splitter missing");
      const beforeResize = (await geometry()).box?.width;
      if (!beforeResize) throw new Error("Page size missing");
      await p.mouse.move(grip.x + 2, grip.y + 100);
      await p.mouse.down();
      await p.mouse.move(grip.x - 110, grip.y + 100, { steps: 12 });
      await p.mouse.up();
      await expect
        .poll(async () => (await geometry()).box?.width ?? 0)
        .toBeGreaterThan(beforeResize + 50);
      await expect.poll(exact).toBe(true);
      await s.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1260, 860),
      );
      await expect.poll(exact).toBe(true);
      await s.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.2),
      );
      await expect
        .poll(async () => {
          const { box, native } = await geometry();
          return !!box && !!native && Math.abs(native.bounds.width - box.width * 1.2) < 2;
        })
        .toBe(true);
      await expect.poll(() => nativeRead("devicePixelRatio")).toBeCloseTo(2.4, 1);
      await s.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
      );
      await expect.poll(exact).toBe(true);
      await click("#click");
      await expect.poll(() => nativeRead("window.clicks")).toBe(1);
      await click("#name");
      await expect.poll(() => nativeRead("document.activeElement?.id")).toBe("name");
      await s.app.evaluate(({ webContents }, url) => {
        const c = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
        if (!c) throw new Error("Native fixture missing");
        for (const keyCode of "abc") c.sendInputEvent({ type: "char", keyCode });
      }, s.url);
      await expect.poll(() => nativeRead("document.querySelector('#name').value")).toBe("abc");
      expect(await nativeRead("window.inputs")).toBe(3);
      const nativeChord = (keyCode: string) =>
        s.app.evaluate(
          ({ webContents }, args) => {
            const c = webContents.getAllWebContents().find((entry) => entry.getURL() === args.url);
            if (!c) throw new Error("Native fixture missing");
            c.focus();
            for (const type of ["keyDown", "keyUp"] as const)
              c.sendInputEvent({ type, keyCode: args.keyCode, modifiers: ["meta"] });
          },
          { url: s.url, keyCode },
        );
      await nativeChord("L");
      await expect.poll(() => address.evaluate((input) => input.matches(":focus"))).toBe(true);
      await nativeChord("F");
      await p.getByRole("textbox", { name: "Find text" }).waitFor();
      await p.getByRole("button", { name: "Close find" }).click();
      await nativeChord("K");
      await p.getByRole("dialog").waitFor();
      await expect.poll(async () => (await geometry()).native?.visible).toBe(false);
      await p.keyboard.press("Escape");
      await expect.poll(async () => (await geometry()).native?.visible).toBe(true);
      await click("a[href='/second']");
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.url).toBe(s.url + "second");
      await p
        .getByRole("region", { name: "Thread panel" })
        .getByRole("button", { name: "Back", exact: true })
        .click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.url).toBe(s.url);
      expect(await nativeRead("document.querySelector('#name').value")).toBe("abc");
      await p
        .getByRole("region", { name: "Thread panel" })
        .getByRole("button", { name: "Forward", exact: true })
        .click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.url).toBe(s.url + "second");
      await p
        .getByRole("region", { name: "Thread panel" })
        .getByRole("button", { name: "Back", exact: true })
        .click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.url).toBe(s.url);
      await p.getByRole("button", { name: "Reload", exact: true }).click();
      await expect.poll(() => nativeRead("document.querySelector('#name').value")).toBe("");
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "Find in page" }).click();
      await p.getByRole("textbox", { name: "Find text" }).fill("needle");
      await expect.poll(() => p.getByRole("search").innerText()).toMatch(/matches|\d+ of \d+/);
      await p.getByRole("button", { name: "Close find" }).click();
      // Browser chords and ordinary target=_blank links reuse the main page.
      const panel = p.getByRole("region", { name: "Thread panel" });
      await nativeChord("T");
      expect(s.daemon.browser.state(s.thread.id)?.tabs).toHaveLength(1);
      await nativeRead(
        "(()=>{const a=document.createElement('a');a.href='/popup';a.target='_blank';document.body.append(a);a.click()})()",
      );
      await expect.poll(() => address.inputValue()).toContain("/popup");
      expect(s.daemon.browser.state(s.thread.id)?.tabs).toHaveLength(1);
      await panel.getByRole("button", { name: "Back", exact: true }).click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.url).toBe(s.url);
      await click("button[onclick*=alert]");
      await p.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true }).click();
      await p.getByRole("alertdialog").waitFor({ state: "hidden" });
      await click("button[onclick*=confirm]");
      await p.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true }).click();
      await expect
        .poll(() => nativeRead("document.querySelector('#result').textContent"))
        .toBe("true");
      await p.getByRole("alertdialog").waitFor({ state: "hidden" });
      await click("button[onclick*=prompt]");
      await p.getByRole("textbox", { name: "Answer", exact: true }).fill("answered");
      await p.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true }).click();
      await expect
        .poll(() => nativeRead("document.querySelector('#result').textContent"))
        .toBe("answered");
      await p.getByRole("alertdialog").waitFor({ state: "hidden" });
      await nativeRead(
        "setTimeout(()=>document.querySelector('iframe').contentWindow.document.querySelector('button[onclick*=prompt]').click(),0)",
      );
      await p.getByRole("textbox", { name: "Answer", exact: true }).fill("iframe answer");
      await p.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true }).click();
      await expect
        .poll(() =>
          nativeRead(
            "document.querySelector('iframe').contentWindow.document.querySelector('#result').textContent",
          ),
        )
        .toBe("iframe answer");
      await p.getByRole("alertdialog").waitFor({ state: "hidden" });
      const crossFrame = (expression: string) =>
        s.app.evaluate(
          ({ webContents }, args) => {
            const contents = webContents.getAllWebContents().find((c) => c.getURL() === args.url);
            const frame = contents?.mainFrame.framesInSubtree.find((candidate) =>
              candidate.url.startsWith("http://localhost:"),
            );
            if (!frame) throw new Error("Cross-origin fixture frame missing");
            return frame.executeJavaScript(args.expression);
          },
          { url: s.url, expression },
        );
      await expect.poll(() => crossFrame("typeof window.__aceDialog")).toBe("function");
      expect(await crossFrame("typeof require")).toBe("undefined");
      await crossFrame(
        "setTimeout(()=>document.querySelector('button[onclick*=prompt]').click(),0)",
      );
      await p.getByRole("textbox", { name: "Answer", exact: true }).fill("cross-origin answer");
      await p.getByRole("alertdialog").getByRole("button", { name: "OK", exact: true }).click();
      await expect
        .poll(() => crossFrame("document.querySelector('#result').textContent"))
        .toBe("cross-origin answer");
      await p.getByRole("alertdialog").waitFor({ state: "hidden" });
      expect(await nativeRead("document.querySelector('#video').paused")).toBe(false);
      await s.app.evaluate(({ webContents }, url) => {
        const c = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
        c?.focus();
        c?.sendInputEvent({ type: "mouseWheel", x: 20, y: 200, deltaY: -600, deltaX: 0 });
      }, s.url);
      await expect.poll(() => nativeRead("scrollY")).toBeGreaterThan(100);
      await nativeRead(
        "new Promise(resolve=>{const done=()=>{removeEventListener('scrollend',done);resolve(0)};addEventListener('scrollend',done,{once:true});setTimeout(done,1500)})",
      );
      await nativeRead("window.scrollTo({top:0,behavior:'instant'})");
      await nativeRead(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      await expect.poll(() => nativeRead("scrollY")).toBe(0);
      await click("a[href='/download']");
      await expect
        .poll(
          () =>
            s.daemon.browser
              .state(s.thread.id)
              ?.downloads?.find((d) => d.filename === "fixture.txt")?.state,
          { timeout: 30000 },
        )
        .toBe("complete");
      const file = s.daemon.browser
        .state(s.thread.id)
        ?.downloads?.find((d) => d.filename === "fixture.txt")?.path;
      if (!file) throw new Error("Download artifact missing");
      expect(await readFile(file, "utf8")).toBe("sandbox download\n");
      await p.getByRole("button", { name: "Site access" }).click();
      await p.getByText("Site access in this thread", { exact: true }).waitFor();
      await expect.poll(async () => (await geometry()).native?.visible).toBe(true);
      await p.keyboard.press("Escape");
      const pageSize = async (name: string | RegExp) => {
        await p.getByRole("button", { name: "Browser options" }).click();
        await p.getByRole("menuitemradio", { name }).click();
      };
      await pageSize(/iPhone 16 Pro/);
      await expect.poll(() => nativeRead("innerWidth")).toBe(402);
      await expect.poll(() => nativeRead("devicePixelRatio")).toBe(3);
      await p.getByRole("menu").waitFor({ state: "hidden" });
      const emulated = (await geometry()).native?.bounds;
      if (!emulated) throw new Error("Native emulation missing");
      expect(emulated.width / emulated.height).toBeCloseTo(402 / 874, 2);
      await pageSize(/Laptop/);
      await expect.poll(() => nativeRead("innerWidth")).toBe(1280);
      await expect.poll(() => nativeRead("devicePixelRatio")).toBe(1);
      await pageSize("Fit the panel");
      await expect.poll(exact).toBe(true);
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "Copy address", exact: true }).click();
      await expect.poll(() => s.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(s.url);
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "Open in your browser", exact: true }).click();
      expect(await s.app.evaluate(() => Reflect.get(globalThis, "testOpened"))).toContain(s.url);
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "Record the page", exact: true }).click();
      await click("#click");
      await p.getByRole("button", { name: "Make private", exact: true }).click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.takeoverMode).toBe("private");
      await p.getByRole("button", { name: "Browser options" }).click();
      await p.getByRole("menuitem", { name: "Stop recording", exact: true }).click();
      await p.getByText("Recording saved to this thread", { exact: true }).waitFor();
      await p.getByRole("button", { name: "Hand back", exact: true }).click();
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.controller).toBe("agent");
      await p.getByRole("button", { name: "Take over", exact: true }).click();
      await p.keyboard.press("Control+Shift+B");
      await expect.poll(async () => (await geometry()).native?.visible).toBe(false);
      await p.keyboard.press("Control+Shift+B");
      await expect.poll(exact).toBe(true);
      await p.getByRole("button", { name: "Show sidebar", exact: true }).click();
      await p.getByRole("link", { name: /Other fixture/ }).click();
      await expect.poll(async () => !!(await geometry()).native?.visible).toBe(false);
      await expect.poll(() => s.daemon.browser.state(s.thread.id)?.controller).toBe("agent");
      await s.daemon.browser.closeThread(s.thread.id, { kind: "agent" });
      for (const thread of [s.thread, s.other]) {
        await s.daemon.browser.open({
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          profile: "persistent",
        });
        await s.daemon.browser.execute(thread.id, { action: "navigate", url: s.url });
      }
      await s.daemon.browser.execute(s.thread.id, {
        action: "evaluate",
        expression: 'document.cookie="native-isolation=one; path=/"',
      });
      expect(
        await s.daemon.browser.execute(s.thread.id, {
          action: "evaluate",
          expression: "document.cookie",
        }),
      ).toContain("native-isolation=one");
      expect(
        await s.daemon.browser.execute(s.other.id, {
          action: "evaluate",
          expression: "document.cookie",
        }),
      ).toBe("");
    } catch (error) {
      console.error("Browser panel scenario failed", error);
      await s.page.screenshot({ path: "/tmp/ace-panel-ui.png" });
      console.log("[panel-fixture]", await s.page.locator("body").innerText());
      throw error;
    } finally {
      await s.close();
    }
  },
  240000,
);

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "the agent drives the same native page the person sees, and taking over is instant",
  async () => {
    const s = await browserSandbox();
    try {
      const p = s.page;
      const threadId = s.thread.id;
      const agent = { kind: "agent" } as const;
      await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
      // The agent's MCP tools open the thread's browser for agent work.
      const opened = await s.daemon.browser.open({
        threadId,
        workspaceId: s.thread.workspaceId,
        background: true,
      });
      expect(opened.backend).toBe("embedded");
      await s.daemon.browser.execute(threadId, { action: "navigate", url: s.url }, agent);
      const native = nativePage(s.app, p, s.url);
      // Nobody shows the page yet: it renders unseen, so the agent's screenshot still arrives.
      const shot = await s.daemon.browser.screenshot(threadId);
      expect(shot.byteLength).toBeGreaterThan(1000);
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
      // The panel shows the agent's own page natively: no screencast in between.
      await expect.poll(native.placed, { timeout: 30000 }).toBe(true);
      const page = await native.contentsId();
      const snapshot = z
        .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })) })
        .parse(await s.daemon.browser.execute(threadId, { action: "snapshot" }, agent));
      const marker = snapshot.nodes.find((node) => node.name === "Click marker")?.ref;
      if (!marker) throw new Error("Click marker ref missing");
      await s.daemon.browser.execute(threadId, { action: "click", ref: marker }, agent);
      await expect
        .poll(() => native.read("document.querySelector('#click').textContent"))
        .toBe("Clicked 1");
      expect(await native.placed()).toBe(true);

      const started = performance.now();
      await p.getByRole("button", { name: "Take over", exact: true }).click();
      await expect.poll(() => s.daemon.browser.state(threadId).controller).toBe("human");
      const takeoverMs = performance.now() - started;
      console.log(`[native-takeover] control changed hands in ${takeoverMs.toFixed(0)} ms`);
      // The same live page, never reloaded: the agent's click is still on it.
      expect(await native.contentsId()).toBe(page);
      expect(await native.read("document.querySelector('#click').textContent")).toBe("Clicked 1");
      // Leave the button tooltip before native input.
      await p.mouse.move(0, 0);
      await expect.poll(native.placed).toBe(true);
      await native.personClicks("#click");
      await expect
        .poll(() => native.read("document.querySelector('#click').textContent"))
        .toBe("Clicked 2");
      await expect(
        s.daemon.browser.execute(threadId, { action: "click", ref: marker }, agent),
      ).rejects.toThrow(/controlled by human/);

      await p.getByRole("button", { name: "Hand back", exact: true }).first().click();
      await expect.poll(() => s.daemon.browser.state(threadId).controller).toBe("agent");
      const again = z
        .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })) })
        .parse(await s.daemon.browser.execute(threadId, { action: "snapshot" }, agent))
        .nodes.find((node) => node.name.startsWith("Clicked"))?.ref;
      if (!again) throw new Error("Clicked marker ref missing");
      await s.daemon.browser.execute(threadId, { action: "click", ref: again }, agent);
      await expect
        .poll(() => native.read("document.querySelector('#click').textContent"))
        .toBe("Clicked 3");
      expect(await native.contentsId()).toBe(page);
    } catch (error) {
      console.error("Agent native scenario failed", error);
      await s.page.screenshot({ path: "/tmp/ace-agent-native-ui.png" });
      throw error;
    } finally {
      await s.close();
    }
  },
  240000,
);
