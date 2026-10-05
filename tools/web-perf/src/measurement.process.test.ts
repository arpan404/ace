import { chromium } from "@playwright/test";
import { expect, test } from "vitest";
import {
  observe,
  readRecord,
  resetRecord,
  selectTurn,
  scrollTranscript,
  stepTurn,
} from "@ace/web-perf";

test("buffered tasks from before reset are excluded while a new blocker is counted", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.setContent("<button>Block</button>");
    await page.evaluate(() => {
      document.querySelector("button")?.addEventListener("click", () => {
        const began = performance.now();
        while (performance.now() - began < 130) {
          /* real event timing */
        }
      });
    });
    await page.evaluate(() => {
      const start = performance.now();
      while (performance.now() - start < 150) {
        /* real main-thread task */
      }
    });
    await page.getByRole("button", { name: "Block" }).click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // Installing the buffered observers and resetting in the same task forces
    // old delivery to arrive after reset, rather than depending on CDP scheduling.
    const start = await page.evaluate(
      ({ script }) => {
        const install = new Function(`return (${script})()`);
        install();
        return Reflect.get(globalThis, "acePerfRecord").reset();
      },
      { script: observe.toString() },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect((await readRecord(page, start)).longest).toBe(0);
    expect((await readRecord(page, start)).interactions).toBe(0);
    await page.evaluate(() => {
      const blockingStart = performance.now();
      while (performance.now() - blockingStart < 120) {
        /* deliberate regression */
      }
    });
    await expect
      .poll(async () => (await readRecord(page, start)).longest)
      .toBeGreaterThanOrEqual(120);
    await page.getByRole("button", { name: "Block" }).click();
    await expect.poll(async () => (await readRecord(page, start)).interactions).toBeGreaterThan(0);
    const next = await resetRecord(page);
    expect((await readRecord(page, next)).longest).toBe(0);
  } finally {
    await browser.close();
  }
});

test("reading wheels move the real transcript before the journey continues", async () => {
  const browser = await chromium.launch();
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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<div role="status" aria-label="Jumped">Jumped to turn 137</div><div data-virtual-viewport style="height:200px;overflow:auto"><div role="feed" aria-label="Transcript" aria-busy="false"><article style="height:2000px">Transcript</article></div></div><script>document.onkeydown=()=>setTimeout(()=>{document.querySelector('[data-virtual-viewport]').scrollTop=500},25)</script>`,
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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <aside aria-label="Turns"><div><h2>Turns</h2><span></span></div>
      <div role="listbox" aria-label="Turns of this thread" tabindex="0" aria-activedescendant="turn-option-777"></div></aside>
      <output aria-label="Jump"></output>
      <script>
        let position=777;
        const list=document.querySelector('[role=listbox]');
        setTimeout(()=>{document.querySelector('span').textContent='2,001';list.focus()},50);
        list.onkeydown=e=>{
          e.preventDefault();
          if(e.key==='Enter'){document.querySelector('output').textContent=position;return;}
          const moves={Home:1,End:2001,PageDown:position+10,PageUp:position-10,ArrowDown:position+1,ArrowUp:position-1};
          if(e.key in moves)setTimeout(()=>{position=moves[e.key];list.setAttribute('aria-activedescendant','turn-option-'+position)},25);
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
