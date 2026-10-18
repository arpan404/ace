import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

/** The isolated world the watcher lives in, and the binding only that world can call. */
const worldName = "ace-person-input";
const bindingName = "__acePersonInput";
/** How long after an agent's input event the page's echo of it is still ignored. */
const agentEchoMs = 300;

/*
 * Runs in its own isolated world in every document of the tab: page scripts can neither see it
 * nor call its binding. Only trusted events count, so a page's synthetic events never pose as
 * the person. One report per 200 ms is plenty for the daemon's 1.5 s quiet window.
 */
const watcher = `(() => {
  if (globalThis.__acePersonInputWatching) return;
  globalThis.__acePersonInputWatching = true;
  const report = globalThis[${JSON.stringify(bindingName)}];
  if (typeof report !== "function") return;

  let last = -Infinity;
  const seen = (event) => {
    if (!event.isTrusted) return;
    const now = performance.now();
    if (now - last < 200) return;
    last = now;
    report("input");
  };
  for (const type of [
    "pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "wheel",
    "keydown", "keyup", "compositionstart", "compositionupdate", "compositionend",
    "beforeinput", "input", "paste", "touchstart", "touchmove", "touchend",
    "dragstart", "drag", "dragover", "drop", "dragend",
  ])
    addEventListener(type, seen, { capture: true, passive: true });
})()`;

const BindingCalled = z.object({ name: z.string() });
/**
 * The person's own input in a tab whose input the daemon does not see: the person's Chrome
 * ("Use my Chrome", ADR 0084), where the extension's debugger reports no real input. A listener
 * in an isolated world, installed over the debugger in every document, reports the person's
 * trusted pointer, key, IME, touch and drag events through a CDP binding. Agent input is trusted
 * too, so `agentInput` wraps the tab's CDP: reports while an agent's `Input.*` command runs, and
 * for `agentEchoMs` after, are the agent's own and ignored.
 */
export function personInputWatch(now: () => number) {
  let agentRunning = 0;
  let agentUntil = Number.NEGATIVE_INFINITY;
  return {
    /** The tab's CDP, with every agent `Input.*` command marked as the agent's. */
    agentInput(send: BrowserCdp["send"]): BrowserCdp["send"] {
      return async (method, params) => {
        if (!method.startsWith("Input.")) return send(method, params);
        agentRunning++;
        try {
          return await send(method, params);
        } finally {
          agentRunning--;
          agentUntil = now() + agentEchoMs;
        }
      };
    },
    /** Installs the listener in the tab's documents; `person` hears each report. */
    async install(cdp: BrowserCdp, person: () => void): Promise<() => void> {
      const called = (raw: unknown) => {
        const call = BindingCalled.safeParse(raw);
        if (!call.success || call.data.name !== bindingName) return;
        if (agentRunning > 0 || now() < agentUntil) return;
        person();
      };
      cdp.on("Runtime.bindingCalled", called);
      try {
        await cdp.send("Runtime.addBinding", {
          name: bindingName,
          executionContextName: worldName,
        });
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: watcher,
          worldName,
          // Also the documents already loaded: a shared tab is claimed with its page open.
          runImmediately: true,
        });
      } catch (error) {
        cdp.off("Runtime.bindingCalled", called);
        throw error;
      }
      return () => cdp.off("Runtime.bindingCalled", called);
    },
  };
}
