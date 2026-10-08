import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";
import { nativePage } from "./fixtures/native-page.ts";

/**
 * Non-gating bench (ADR 0069): what the person waits for when an agent drives the thread's
 * browser, with the desktop's native view against ace's headless Chromium shown through the
 * panel's JPEG screencast. Run with ACE_E2E_ELECTRON=1 ACE_BENCH_BROWSER=1; it prints and writes
 * `/tmp/ace-browser-latency.json`. Wall-clock times on one machine; never asserted.
 *
 * - load: an agent navigation, until the daemon reports DOMContentLoaded.
 * - visible: an agent click, until the person can see its effect: the native page painted it,
 *   or the panel displayed the first screencast frame after the headless page painted it.
 * - fps: pictures of an animated page the person sees per second (native paints, or
 *   screencast frames the panel displays).
 * - takeover: the person's Take over click, until the daemon hands them the lease.
 */
const rounds = 15;
const agent = { kind: "agent" } as const;
const arm = `window.__paintAt=0;document.querySelector('#click').addEventListener('click',()=>requestAnimationFrame(()=>setTimeout(()=>{window.__paintAt=Date.now()})),{once:true});0`;
const Snapshot = z.object({
  nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })),
});

const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { median: at(0.5), p90: at(0.9), min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
};

async function measure(backend: "auto" | "headless") {
  const s = await browserSandbox(backend);
  try {
    const p = s.page;
    const threadId = s.thread.id;
    const execute = (command: unknown) => s.daemon.browser.execute(threadId, command, agent);
    await p.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30000 });
    await s.daemon.browser.open({ threadId, workspaceId: s.thread.workspaceId, background: true });
    await execute({ action: "navigate", url: s.url });
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
    const native = nativePage(s.app, p, s.url);
    if (backend === "auto") await expect.poll(native.placed, { timeout: 30000 }).toBe(true);
    else await p.locator("[data-browser-page] img").first().waitFor({ timeout: 30000 });

    const load: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const target = round % 2 ? s.url : `${s.url}second`;
      const started = Date.now();
      await execute({ action: "navigate", url: target });
      load.push(Date.now() - started);
    }
    await execute({ action: "navigate", url: s.url });
    if (backend === "auto") await expect.poll(native.placed, { timeout: 30000 }).toBe(true);

    // Every screencast frame the panel displays, by when it was displayed.
    await p.evaluate(() => {
      const shown: number[] = [];
      Reflect.set(window, "__frames", shown);
      const area = document.querySelector("[data-browser-page]");
      if (!area) return;
      new MutationObserver(() => shown.push(Date.now())).observe(area, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
      });
    });
    const read = (expression: string) =>
      backend === "auto"
        ? native.read(expression)
        : execute({ action: "evaluate", expression, mode: "unrestricted" });
    const ref = Snapshot.parse(await execute({ action: "snapshot" })).nodes.find(
      (node) => node.name === "Click marker",
    )?.ref;
    if (!ref) throw new Error("Click marker ref missing");
    const visible: number[] = [];
    for (let round = 0; round < rounds; round++) {
      await read(arm);
      const started = Date.now();
      await execute({ action: "click", ref });
      let paintedAt = 0;
      await expect
        .poll(async () => (paintedAt = z.number().parse(await read("window.__paintAt"))))
        .toBeGreaterThan(0);
      if (backend === "auto") {
        visible.push(paintedAt - started);
        continue;
      }
      let shownAt = 0;
      await expect
        .poll(async () => {
          const frames = z
            .array(z.number())
            .parse(await p.evaluate(() => Reflect.get(window, "__frames")));
          shownAt = frames.find((at) => at >= paintedAt) ?? 0;
          return shownAt;
        })
        .toBeGreaterThan(0);
      visible.push(shownAt - started);
    }

    // The animated fixture: how many distinct pictures of it the person sees per second.
    const frames = async () =>
      z.array(z.number()).parse(await p.evaluate(() => Reflect.get(window, "__frames"))).length;
    const before = backend === "auto" ? 0 : await frames();
    const painted =
      backend === "auto"
        ? z
            .number()
            .parse(
              await native.read(
                "new Promise(r=>{let n=0;const end=performance.now()+2000;const f=()=>{n++;performance.now()<end?requestAnimationFrame(f):r(n)};requestAnimationFrame(f)})",
              ),
            )
        : await new Promise<number>((resolve) =>
            setTimeout(() => void frames().then((after) => resolve(after - before)), 2000),
          );
    const fps = painted / 2;

    const started = Date.now();
    await p.getByRole("button", { name: "Take over", exact: true }).click();
    await expect.poll(() => s.daemon.browser.state(threadId).controller).toBe("human");
    const takeover = Date.now() - started;
    return {
      backend: s.daemon.browser.state(threadId).backend,
      load: stats(load),
      visible: stats(visible),
      fps,
      takeover,
    };
  } finally {
    await s.close();
  }
}

it.runIf(process.env.ACE_E2E_ELECTRON === "1" && process.env.ACE_BENCH_BROWSER === "1")(
  "bench: agent-driven page load and interaction latency, native view against headless screencast",
  async () => {
    const results = { rounds, native: await measure("auto"), headless: await measure("headless") };
    console.log(`[browser-latency] ${JSON.stringify(results, null, 2)}`);
    await writeFile("/tmp/ace-browser-latency.json", JSON.stringify(results, null, 2));
  },
  480000,
);
