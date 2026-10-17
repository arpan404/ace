import { describe, expect, it } from "vitest";
import type { Actor } from "./session-options.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

/*
 * People and agents sharing one tab of ace's own Chrome (ADR 0067, "Collaboration"). The
 * person's input arrives the way a live viewer sends it; agents act through the service.
 */
const agent: Actor = { kind: "agent", agentId: "agent" };
const key = (char: string) => ({ kind: "key", event: "char", key: char }) as const;
const slowPerson = { quietMs: 3_000, maxWaitMs: 8_000, inUseMs: 1_000, followAfterMs: 1_000 };

describe.skipIf(!executablePath)("people and agents in one tab", () => {
  it("an agent's snapshot, find, screenshot and logs answer at once while its click waits for the person", async () => {
    const f = await fixture({ collaboration: slowPerson });
    await f.navigate();
    const save = ref(await f.execute({ action: "snapshot" }), "Save");
    await f.service.input("thread", key("x"), "person");
    let clicked = false;
    const click = f.service
      .execute("thread", { action: "click", ref: save }, agent)
      .then(() => (clicked = true));
    const started = Date.now();
    await f.service.execute("thread", { action: "snapshot" }, agent);
    await f.service.execute("thread", { action: "find", role: "button", name: "Save" }, agent);
    await f.service.screenshot("thread", undefined, undefined, {}, agent);
    await f.service.execute("thread", { action: "logs" }, agent);
    expect(Date.now() - started).toBeLessThan(slowPerson.quietMs - 1_000);
    expect(clicked).toBe(false);
    await click;
  }, 60_000);
});
