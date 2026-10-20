import { describe, expect, it } from "vitest";
import type { Actor } from "./session-options.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

/*
 * An agent's click aims at an element that is still moving (ADR 0067, "Clicks land where they
 * aim"). The page is ace's own Chrome; the person sets the stage.
 */
const agent: Actor = { kind: "agent", agentId: "agent" };
const person: Actor = { kind: "human", connectionId: "person" };

async function page(html: string) {
  const f = await fixture();
  await f.navigate();
  const run = (expression: string) =>
    f.service.execute("thread", { action: "evaluate", expression }, person);
  await run(`document.body.innerHTML = ${JSON.stringify(html)}; true`);
  const snapshot = await f.service.execute("thread", { action: "snapshot" }, agent);
  const click = (name: string) =>
    f.service.execute("thread", { action: "click", ref: ref(snapshot, name) }, agent);
  return { run, click };
}

describe.skipIf(!executablePath)("an agent's click on a moving element", () => {
  it("waits for a sliding button to stop, then clicks it where it came to rest", async () => {
    const { run, click } = await page(
      `<button id="go" style="height:30px" onclick="this.textContent='Clicked'">Go</button>`,
    );
    // The button slides far down, fast, as content loads above it; the agent clicks mid-slide.
    await run(
      `document.getElementById('go').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(3000px)' }], { duration: 600, fill: 'forwards' }); true`,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await click("Go");
    expect(await run("document.getElementById('go').textContent")).toBe("Clicked");
  }, 60_000);

  it("refuses a button that never stops moving, clicking nothing", async () => {
    const { run, click } = await page(
      `<button id="go" style="height:30px" onclick="this.textContent='Clicked'">Go</button>`,
    );
    await run(
      `document.getElementById('go').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(400px)' }], { duration: 300, iterations: Infinity, direction: 'alternate' }); true`,
    );
    await expect(click("Go")).rejects.toMatchObject({ code: "not_hittable" });
    expect(await run("document.getElementById('go').textContent")).toBe("Go");
  }, 60_000);

  it("clicks a button that pulses in place without waiting for it to stop", async () => {
    const { run, click } = await page(
      `<button id="go" style="height:30px" onclick="this.textContent='Clicked'">Go</button>`,
    );
    await run(
      `document.getElementById('go').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }], { duration: 300, iterations: Infinity, direction: 'alternate' }); true`,
    );
    await click("Go");
    expect(await run("document.getElementById('go').textContent")).toBe("Clicked");
  }, 60_000);
});
