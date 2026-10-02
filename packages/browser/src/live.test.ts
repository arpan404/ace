import { describe, expect, it } from "vitest";
import type { BrowserFrame, BrowserState } from "@ace/protocol";
import { executablePath, fixture, ref } from "./test-support.ts";

describe.skipIf(!executablePath)("live Chromium and controller ownership", () => {
  it("delivers JPEG frames to two viewers while the slow viewer skips intermediate frames", async () => {
    const f = await fixture();
    await f.navigate();
    const fast: BrowserFrame[] = [],
      slow: BrowserFrame[] = [];
    const { promise: reached, resolve: ready } = Promise.withResolvers<void>();
    const stopFast = f.service.subscribe(
      "thread",
      "fast",
      {
        send: (frame) => {
          fast.push(frame);
          f.service.acknowledge("thread", "fast", frame.sequence);
          if (fast.length >= 4) ready();
          return true;
        },
      },
      () => {},
    );
    const stopSlow = f.service.subscribe(
      "thread",
      "slow",
      {
        send: (frame) => {
          slow.push(frame);
          return true;
        },
      },
      () => {},
    );
    try {
      await f.evaluate(
        "window.animating=true; window.counter=0; function animate(){ if(!window.animating)return;document.body.style.background=`rgb(${++window.counter%255},30,80)`;requestAnimationFrame(animate)};animate()",
      );
      await reached;
      expect(slow).toHaveLength(1);
      const first = slow[0];
      if (!first) throw new Error("No initial frame");
      f.service.acknowledge("thread", "slow", first.sequence);
      expect(slow).toHaveLength(2);
      expect(slow[1]?.sequence).toBe(fast.at(-1)?.sequence);
      expect(Buffer.from(first.data, "base64").subarray(0, 2)).toEqual(Buffer.from([255, 216]));
      await f.evaluate("window.animating=false");
    } finally {
      stopFast();
      stopSlow();
    }
  }, 30_000);

  it("blocks agent input during human control and binds human input and hand-back to its owner", async () => {
    const f = await fixture();
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    const states: BrowserState[] = [];
    const stop = f.service.subscribe("thread", "owner", { send: () => false }, (state) =>
      states.push(state),
    );
    f.service.takeover("thread", "owner");
    await expect(f.execute({ action: "type", ref: name, text: "agent" })).rejects.toThrow(
      "controlled by human",
    );
    await expect(
      f.service.input("thread", { kind: "key", event: "char", key: "x", text: "x" }, "other"),
    ).rejects.toThrow("mismatch");
    expect(() => f.service.handback("thread", "other")).toThrow("mismatch");
    await f.service.execute(
      "thread",
      { action: "type", ref: name, text: "human" },
      { kind: "human", connectionId: "owner" },
    );
    await f.service.input("thread", { kind: "key", event: "char", key: "!", text: "!" }, "owner");
    f.service.disconnect("owner");
    expect(await f.evaluate("document.querySelector('input').value")).toBe("human!");
    await f.execute({ action: "type", ref: name, text: "returned" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("returned");
    expect(states.map((state) => state.controller)).toEqual(["agent", "human", "agent"]);
    await f.service.closeThread("thread");
    expect(states.at(-1)?.controller).toBe("none");
    stop();
  }, 30_000);

  it("rejects queued agent input when take-over happens before dispatch", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<boolean>();
    const { promise: seen, resolve: entered } = Promise.withResolvers<void>();
    const f = await fixture({
      evaluatePolicy: () => {
        entered();
        return gate;
      },
    });
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    const active = f.evaluate("1");
    const activeFailure = expect(active).rejects.toThrow("controlled by human");
    await seen;
    const queued = f.execute({ action: "type", ref: name, text: "queued" });
    const queuedFailure = expect(queued).rejects.toThrow("controlled by human");
    f.service.takeover("thread", "human");
    release(true);
    await activeFailure;
    await queuedFailure;
    f.service.handback("thread", "human");
    expect(await f.evaluate("document.querySelector('input').value")).toBe("");
  }, 30_000);
});
