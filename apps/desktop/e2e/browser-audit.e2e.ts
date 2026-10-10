import { expect, it } from "vitest";
import { z } from "zod";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "native browser preserves the page, completes auth, and renders for remote viewers",
  async () => {
    const s = await browserSandbox();
    const thread = s.thread.id;
    const browser = s.daemon.browser;
    try {
      const p = s.page;
      await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
      await browser.open({ threadId: thread, workspaceId: s.thread.workspaceId });
      await browser.execute(thread, { action: "navigate", url: s.url });
      await p.keyboard.press("Control+Shift+B");
      const address = p.getByRole("combobox", { name: "Address" });
      await address.waitFor();
      const native = nativePage(s.app, p, s.url);
      await expect.poll(native.placed, { timeout: 30000 }).toBe(true);
      const contents = await native.contentsId();
      if (contents === undefined) throw new Error("Missing native page");
      const read = (expression: string) =>
        s.app.evaluate(
          ({ webContents }, args) => {
            const c = webContents.fromId(args.id);
            if (!c) throw new Error("Missing native page");
            return c.executeJavaScript(args.expression);
          },
          { id: contents, expression },
        );

      await p.getByRole("button", { name: "Take over", exact: true }).hover();
      await p.getByRole("tooltip").waitFor();
      expect((await native.geometry()).native.visible).toBe(true);
      await p.mouse.move(0, 0);
      await expect(
        browser.execute(thread, { action: "resize", width: 375, height: 800 }),
      ).rejects.toThrow(/visible panel sets/);
      await expect(
        browser.execute(thread, { action: "emulate", width: 375, height: 800 }),
      ).rejects.toThrow(/visible panel sets/);
      const snapshot = z
        .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })) })
        .parse(await browser.execute(thread, { action: "snapshot" }));
      const file = snapshot.nodes.find((node) => node.name === "File")?.ref;
      if (!file) throw new Error("Missing file input");
      await browser.execute(thread, { action: "click", ref: file });
      expect(await browser.execute(thread, { action: "logs" })).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("ace_browser_upload") }),
        ]),
      });

      // Read-only scrolling and Find leave the agent's lease intact.
      await s.app.evaluate(
        ({ webContents }, id) =>
          webContents
            .fromId(id)
            ?.sendInputEvent({ type: "mouseWheel", x: 10, y: 10, deltaY: 40, deltaX: 0 }),
        contents,
      );
      await browser.execute(thread, { action: "find_text", text: "needle" });
      expect(browser.state(thread).controller).toBe("agent");
      await p.getByRole("button", { name: "Take over", exact: true }).click();
      await expect.poll(() => browser.state(thread).controller).toBe("human");
      await p.mouse.move(0, 0);
      await expect.poll(native.placed).toBe(true);
      await read(
        "(()=>{const button=document.createElement('button');button.id='copy-fixture';button.textContent='Copy fixture';button.style='position:fixed;left:16px;top:80px;z-index:10';button.onclick=()=>navigator.clipboard.writeText('native-clipboard-fixture');document.body.append(button)})();void 0",
      );
      await native.personClicks("#copy-fixture");
      await expect
        .poll(() => s.app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe("native-clipboard-fixture");
      await read("document.querySelector('#copy-fixture').remove();void 0");
      await read("navigator.geolocation.getCurrentPosition(()=>{},()=>{});void 0");
      await p.getByRole("status", { name: "Site access blocked: location" }).waitFor();
      await read(
        "document.cookie='audit=retained;path=/';window.received='';window.addEventListener('message',e=>window.received=e.data);window.open('/popup','auth','width=500,height=600');void 0",
      );
      await expect
        .poll(() =>
          s.app.evaluate(
            ({ webContents }, url) =>
              webContents.getAllWebContents().some((c) => c.getURL() === url),
            s.url + "popup",
          ),
        )
        .toBe(true);
      await s.app.evaluate(async ({ webContents }, url) => {
        const c = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
        if (!c) throw new Error("Auth popup missing");
        await c.executeJavaScript(
          "opener.postMessage('auth-complete',location.origin);window.close();void 0",
        );
      }, s.url + "popup");
      await expect.poll(() => read("window.received")).toBe("auth-complete");
      expect(browser.state(thread).tabs).toHaveLength(1);

      // Zoom belongs to the page and survives panel movement.
      await s.app.evaluate(({ webContents }, id) => {
        const c = webContents.fromId(id);
        c?.sendInputEvent({ type: "keyDown", keyCode: "+", modifiers: ["meta"] });
        c?.sendInputEvent({ type: "keyUp", keyCode: "+", modifiers: ["meta"] });
      }, contents);
      const zoom = () =>
        s.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor(), contents);
      await expect.poll(zoom).toBeGreaterThan(1);
      const before = await zoom();
      await p.getByRole("button", { name: "Hide sidebar" }).click();
      await expect.poll(zoom).toBe(before);
      await address.fill(s.url + "auth");
      await address.press("Enter");
      await expect
        .poll(
          () =>
            s.app
              .context()
              .pages()
              .find((page) => page.url().startsWith("data:text/html,")),
          { timeout: 15000 },
        )
        .toBeTruthy();
      const prompt = s.app
        .context()
        .pages()
        .find((page) => page.url().startsWith("data:text/html,"));
      if (!prompt) throw new Error("Sign-in prompt missing");
      await prompt.getByLabel("Username").fill("fixture");
      await prompt.getByLabel("Password").fill("fixture");
      await prompt.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect.poll(() => browser.state(thread).url).toBe(s.url + "auth");
      await expect
        .poll(() => read("document.querySelector('h1')?.textContent"))
        .toBe("Fixture needle");
      await read("history.pushState({},'', '/spa');void 0");
      await expect.poll(() => browser.state(thread).url).toBe(s.url + "spa");
      await expect.poll(() => address.inputValue()).toBe(s.url.replace(/^http:\/\//, "") + "spa");

      // A web connection gets changing frames while holding an unseen native page.
      await p.getByRole("button", { name: "Right panel" }).click();
      await expect.poll(() => browser.state(thread).controller).toBe("agent");
      browser.takeover(thread, "remote");
      let latest = "";
      let count = 0;
      const stop = browser.subscribe(
        thread,
        "remote",
        {
          send(frame) {
            latest = frame.data;
            count++;
            queueMicrotask(() => browser.acknowledge(thread, "remote", frame.sequence));
            return true;
          },
        },
        () => {},
      );
      await expect.poll(() => count, { timeout: 15000 }).toBeGreaterThan(1);
      const first = latest;
      await expect.poll(() => latest, { timeout: 15000 }).not.toBe(first);
      stop();
    } catch (error) {
      console.error("Audit scenario failed", error);
      throw error;
    } finally {
      await s.close();
    }
  },
  240000,
);
