import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executablePath, fixture, ref } from "./test-support.ts";
import { z } from "zod";

describe.skipIf(!executablePath)("agent browser API with real Chromium", () => {
  it("navigates, edits by accessibility ref, clicks, presses, scrolls and saves a screenshot", async () => {
    const f = await fixture();
    await f.navigate();
    const snapshot = await f.execute({ action: "snapshot" });
    await f.execute({ action: "type", ref: ref(snapshot, "Name"), text: "Ada" });
    await f.execute({ action: "click", ref: ref(snapshot, "Save") });
    expect(await f.evaluate("document.getElementById('result').textContent")).toBe("Ada");
    await f.execute({ action: "press", ref: ref(snapshot, "Name"), key: "Enter" });
    expect(await f.evaluate("document.getElementById('result').textContent")).toBe("entered");
    await f.execute({ action: "scroll", x: 0, y: 500 });
    await f.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    expect(await f.evaluate("window.scrollY")).toBeGreaterThan(0);
    const image = z.object({ path: z.string() }).parse(await f.execute({ action: "screenshot" }));
    expect((await readFile(image.path)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }, 60_000);

  it("keeps refs stable across snapshots and DOM edits and rejects detached or navigated refs", async () => {
    const f = await fixture();
    await f.navigate();
    const first = await f.execute({ action: "snapshot" });
    const name = ref(first, "Name"),
      gone = ref(first, "Remove me");
    await f.evaluate(
      "document.body.append(document.createElement('p')); document.getElementById('gone').remove()",
    );
    await expect(f.execute({ action: "click", ref: gone })).rejects.toThrow();
    const second = await f.execute({ action: "snapshot" });
    expect(ref(second, "Name")).toBe(name);
    await f.execute({ action: "type", ref: name, text: "stable" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("stable");
    await f.navigate();
    await expect(f.execute({ action: "click", ref: name })).rejects.toThrow(/ref/);
    expect(ref(await f.execute({ action: "snapshot" }), "Name")).not.toBe(name);
  }, 60_000);

  it("applies viewport, media and touch emulation", async () => {
    const f = await fixture();
    await f.navigate();
    await f.execute({ action: "resize", width: 480, height: 640 });
    expect(await f.evaluate("innerWidth")).toBe(480);
    await f.execute({
      action: "emulate",
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
      touch: true,
      colorScheme: "dark",
    });
    expect(
      await f.evaluate(
        "[innerWidth, devicePixelRatio, matchMedia('(prefers-color-scheme: dark)').matches, navigator.maxTouchPoints]",
      ),
    ).toEqual([390, 2, true, 1]);
  }, 60_000);

  it("returns console and network results inline without host paths", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      "fetch('/data').then(r=>r.text()).then(text=>console.log('network-complete '+text))",
    );
    const logs = z
      .object({
        entries: z.array(
          z.object({
            text: z.string(),
            kind: z.string(),
            status: z.number().optional(),
            url: z.string().optional(),
          }),
        ),
      })
      .parse(await f.execute({ action: "logs" }));
    expect(logs.entries.some((entry) => entry.text.includes("console-marker"))).toBe(true);
    expect(
      logs.entries.some((entry) => entry.text.includes("network-complete response-data")),
    ).toBe(true);
    expect(
      logs.entries.some((entry) => entry.status === 200 && entry.url === `${f.url}/data`),
    ).toBe(true);
  }, 60000);

  it("denies evaluate separately from navigation and rejects external and file origins", async () => {
    const f = await fixture({ evaluatePolicy: () => false });
    await f.navigate();
    await expect(f.evaluate("1+1")).rejects.toThrow("requires approval");
    await expect(
      f.execute({ action: "navigate", url: "file:///etc/passwd" }),
    ).rejects.toMatchObject({
      blocked: { reason: "invalid_origin", origin: "file:///etc/passwd" },
    });
    await expect(
      f.execute({ action: "navigate", url: "https://example.invalid" }),
    ).rejects.toMatchObject({
      blocked: { reason: "approval_required", origin: "https://example.invalid" },
    });
    await expect(f.execute({ action: "navigate", url: `${f.url}/redirect` })).rejects.toThrow();
  }, 60_000);

  it("checks subresources and redirects against the origin hook before making network requests", async () => {
    const origins: string[] = [];
    const f = await fixture({
      originPolicy: ({ url }) => {
        origins.push(url);
        return false;
      },
    });
    await f.navigate();
    expect(await f.evaluate("fetch('https://example.invalid/data').then(()=>false,()=>true)")).toBe(
      true,
    );
    expect(origins).toContain("https://example.invalid/data");
    await expect(f.execute({ action: "navigate", url: `${f.url}/redirect` })).rejects.toThrow();
    expect(origins).toContain("https://example.invalid/");
  }, 60_000);

  it("checks redirect hops initiated by a cross-site iframe", async () => {
    const origins: string[] = [];
    const f = await fixture({
      originPolicy: ({ url }) => {
        origins.push(url);
        return false;
      },
    });
    await f.navigate();
    const frameUrl = `${f.url.replace("127.0.0.1", "localhost")}/iframe`;
    await f.evaluate(
      `new Promise(resolve=>{addEventListener('message',()=>resolve(true),{once:true});const iframe=document.createElement('iframe');iframe.src=${JSON.stringify(frameUrl)};document.body.append(iframe)})`,
    );
    expect(origins).toContain("https://example.invalid/");
  }, 60_000);
});
