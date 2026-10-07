import { chromium } from "@playwright/test";
import { expect, inject, test } from "vitest";
import {
  observe,
  readRecord,
  resetRecord,
  streamedRate,
  selectTurn,
  scrollTranscript,
  stepTurn,
} from "@ace/web-perf";

const launch = () => chromium.launch({ executablePath: inject("chromiumExecutable") });

test("streamed rate pairs completed batch counters with their delivery timestamps", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.evaluate(observe);
    // Inject the clock and cumulative deliveries so scheduling cannot change the verdict.
    await page.evaluate(() => {
      Object.assign(globalThis, { acePerf: { events: 700, at: 992 }, aceSampleTime: 1_000 });
      performance.now = () => Reflect.get(globalThis, "aceSampleTime");
    });
    const start = await resetRecord(page);
    await page.evaluate(() => {
      Object.assign(Reflect.get(globalThis, "acePerf"), { events: 10_800, at: 2_992 });
      Reflect.set(globalThis, "aceSampleTime", 3_008);
    });
    const sample = await readRecord(page, start);
    // Later deliveries and time must not change the already captured window.
    await page.evaluate(() => {
      Object.assign(Reflect.get(globalThis, "acePerf"), { events: 20_800, at: 6_992 });
      Reflect.set(globalThis, "aceSampleTime", 7_000);
    });
    expect(sample.seconds).toBe(2.008);
    expect(sample.streamedSeconds).toBe(2);
    expect(streamedRate(sample)).toBe(5_050);
    const next = await resetRecord(page);
    await page.evaluate(() => Reflect.set(globalThis, "aceSampleTime", 8_000));
    expect(streamedRate(await readRecord(page, next))).toBe(0);
    await expect(readRecord(page, start)).rejects.toThrow("Measurement window was reset");
  } finally {
    await browser.close();
  }
});

test("buffered tasks from before reset are excluded while a new blocker is counted", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.setContent("<button>Block</button>");
    await page.evaluate(() => {
      // These observers acknowledge native delivery, including Event Timing's
      // post-paint delivery. Animation frames alone do not prove that happened.
      // This helper must travel with the serialized browser-side callback.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const delivered = (from: number) =>
        Promise.all(
          (["longtask", "event"] as const).map(
            (type) =>
              new Promise<void>((resolve) => {
                const observer = new PerformanceObserver((list) => {
                  if (
                    list
                      .getEntries()
                      .some(
                        (entry) =>
                          entry.startTime >= from &&
                          (type === "longtask"
                            ? entry.duration >= 120
                            : "interactionId" in entry && Number(entry.interactionId) > 0),
                      )
                  ) {
                    observer.disconnect();
                    resolve();
                  }
                });
                const options = { type, buffered: true, durationThreshold: 16 };
                observer.observe(options);
              }),
          ),
        );
      Object.assign(globalThis, {
        aceBlockDelivered: delivered(performance.now()),
        aceAwaitBlock: delivered,
      });
      document.querySelector("button")?.addEventListener("click", () => {
        const began = performance.now();
        while (performance.now() - began < 130) {
          /* deliberate real task and interaction */
        }
      });
    });
    await page.getByRole("button", { name: "Block" }).click();
    await page.evaluate(() => Reflect.get(globalThis, "aceBlockDelivered"));
    // Installing the buffered observers and resetting in the same task forces
    // old delivery to arrive after reset, rather than depending on CDP scheduling.
    const start = await page.evaluate(
      ({ script }) => {
        const install = new Function(`return (${script})()`);
        install();
        const windowStart = Reflect.get(globalThis, "acePerfRecord").reset();
        // Registered after the measurement observers: their buffered callbacks
        // run before this delivery acknowledgment resolves.
        Object.assign(globalThis, {
          aceBlockDelivered: Reflect.get(globalThis, "aceAwaitBlock")(0),
        });
        return windowStart;
      },
      { script: observe.toString() },
    );
    await page.evaluate(() => Reflect.get(globalThis, "aceBlockDelivered"));
    expect((await readRecord(page, start)).longest).toBe(0);
    expect((await readRecord(page, start)).interactions).toBe(0);
    await page.evaluate(() => {
      Object.assign(globalThis, {
        aceBlockDelivered: Reflect.get(globalThis, "aceAwaitBlock")(performance.now()),
      });
    });
    // CDP evaluate is not a browser event-loop task for Long Tasks reporting.
    // Dispatch a real input, then await both native observers instead of polling.
    await page.getByRole("button", { name: "Block" }).click();
    await page.evaluate(() => Reflect.get(globalThis, "aceBlockDelivered"));
    const sample = await readRecord(page, start);
    expect(sample.longest).toBeGreaterThanOrEqual(120);
    expect(sample.interactions).toBeGreaterThan(0);
    const next = await resetRecord(page);
    expect((await readRecord(page, next)).longest).toBe(0);
  } finally {
    await browser.close();
  }
});

test("reading wheels move the real transcript before the journey continues", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<div data-virtual-viewport style="height:200px;overflow:auto"><div role="feed" aria-label="Transcript" aria-busy="false"><article style="height:2000px">Transcript</article></div></div>`,
    );
    await scrollTranscript(page, 900, 120);
    const viewport = page.locator("[data-virtual-viewport]");
    const down = await viewport.evaluate((element) => element.scrollTop);
    expect(down).toBeGreaterThan(0);
    await scrollTranscript(page, -700, 120);
    expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThan(down);
  } finally {
    await browser.close();
  }
});

test("turn keys can acknowledge an in-window scroll without replacing the jump", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<div role="status" aria-label="Jumped">Jumped to turn 137</div><div data-virtual-viewport style="height:200px;overflow:auto"><div role="feed" aria-label="Transcript" aria-busy="false"><article style="height:2000px">Transcript</article></div></div><script>
        const commit = new MessageChannel();
        commit.port1.onmessage=()=>{document.querySelector('[data-virtual-viewport]').scrollTop=500};
        document.onkeydown=()=>commit.port2.postMessage('scroll');
      </script>`,
    );
    await stepTurn(page, "ArrowDown");
    expect(
      await page.locator("[data-virtual-viewport]").evaluate((element) => element.scrollTop),
    ).toBe(500);
    expect(await page.getByRole("status", { name: "Jumped" }).textContent()).toBe(
      "Jumped to turn 137",
    );
  } finally {
    await browser.close();
  }
});

test.each([137, 1777])("delayed Home/End commits still jump to turn %i", async (target) => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <aside aria-label="Turns"><div><h2>Turns</h2><span></span></div>
      <div role="listbox" aria-label="Turns of this thread" tabindex="0" aria-activedescendant="turn-option-777"></div></aside>
      <output aria-label="Jump"></output>
      <script>
        let position=777;
        const list=document.querySelector('[role=listbox]');
        const commit = new MessageChannel();
        commit.port1.onmessage=({data})=>{
          if(data==='ready'){document.querySelector('span').textContent='2,001';list.focus();return;}
          position=data;list.setAttribute('aria-activedescendant','turn-option-'+position);
        };
        commit.port2.postMessage('ready');
        list.onkeydown=e=>{
          e.preventDefault();
          if(e.key==='Enter'){document.querySelector('output').textContent=position;return;}
          const moves={Home:1,End:2001,PageDown:position+10,PageUp:position-10,ArrowDown:position+1,ArrowUp:position-1};
          if(e.key in moves)commit.port2.postMessage(moves[e.key]);
        };
      </script>
    `);
    await selectTurn(page, target);
    await page.keyboard.press("Enter");
    expect(await page.locator("output").textContent()).toBe(String(target));
  } finally {
    await browser.close();
  }
});
