import { keepBrowserEngine, moveBrowserEngine, type ClientCore } from "@ace/client";
import type { BrowserState } from "@ace/protocol";
import { browserEngineChoices, browserEngineLabel } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { reason } from "./browser-tools.ts";

/*
 * "Engine for this thread" from the phone, as web's ⋯ menu offers it: the thread's browser runs
 * in the desktop app or in ace's Chrome, and the menu names the default other threads use. The
 * move itself is `@ace/client`'s, shared with web.
 */

export const EngineAction = z.object({
  kind: z.literal("engine"),
  engine: z.enum(["embedded", "headless"]),
});
export type EngineAction = z.infer<typeof EngineAction>;

/** Opening the first browser on a machine downloads Chromium. */
const openMs = 10 * 60_000;
const quiet = { timeoutMs: 10_000 };
const SettingEntries = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
});

export interface EngineHost {
  owner: Pick<ClientCore, "request">;
  sink: PatchSink;
  preview: Preview;
  now(): number;
  current(): { threadId: string; state: BrowserState | undefined } | undefined;
  workspaceId(threadId: string): string | undefined;
  /** The engine's state changed (a move started or ended, the default was read). */
  changed(): void;
  /** The browser opened again on the new engine: watch it now. */
  opened(): void;
}

/** The menu's engine section as Swift draws it. */
export function engineView(
  state: BrowserState,
  defaultEngine: string | undefined,
  moving: "embedded" | "headless" | undefined,
) {
  const label = browserEngineLabel(defaultEngine);
  return {
    // Nothing is checked before the thread has a browser, or in the person's own Chrome.
    current:
      moving ??
      (!state.closed && (state.backend === "embedded" || state.backend === "headless")
        ? state.backend
        : null),
    moving: moving !== undefined,
    /** The engines a thread can be moved to, in Settings › Browser's words. */
    choices: browserEngineChoices
      .filter((choice) => choice.value !== "auto")
      .map((choice) => ({ value: choice.value, label: choice.label })),
    note: label
      ? `Other threads use ${label}, the default in Settings › Browser.`
      : "Other threads use the default in Settings › Browser.",
  };
}

export class BrowserEngineTool {
  #host: EngineHost;
  #default: string | undefined;
  #moving: { threadId: string; engine: "embedded" | "headless" } | undefined;
  constructor(host: EngineHost) {
    this.#host = host;
  }
  /** The engine section for the thread shown. */
  view(state: BrowserState, threadId: string) {
    const moving = this.#moving?.threadId === threadId ? this.#moving.engine : undefined;
    return engineView(state, this.#default, moving);
  }
  /** Reads the machine's default engine, for the menu's note. */
  async readDefault(): Promise<void> {
    try {
      const reply = await this.#host.owner.request(
        { type: "settings.get", key: "browser.backend", scope: {} },
        quiet,
      );
      const entry = SettingEntries.parse(reply).entries.find(
        (candidate) => candidate.key === "browser.backend",
      );
      this.#default = typeof entry?.value === "string" ? entry.value : undefined;
    } catch {
      this.#default = undefined;
    }
    this.#host.changed();
  }
  handle(action: EngineAction): void {
    void this.#switch(action.engine);
  }
  async #switch(engine: "embedded" | "headless"): Promise<void> {
    const current = this.#host.current();
    if (!current || this.#moving) return;
    const workspaceId = this.#host.workspaceId(current.threadId);
    if (!workspaceId)
      return this.#problem(
        "Couldn't switch the browser engine. The thread's project isn't known yet.",
      );
    const move = { threadId: current.threadId, workspaceId, engine, openTimeoutMs: openMs };
    this.#moving = { threadId: current.threadId, engine };
    this.#host.changed();
    try {
      if (!current.state || current.state.closed) await keepBrowserEngine(this.#host.owner, move);
      else await moveBrowserEngine(this.#host.owner, move, () => this.#host.opened());
    } catch (error) {
      this.#problem(`Couldn't switch the browser engine. ${reason(error)}`);
    } finally {
      this.#moving = undefined;
      this.#host.changed();
    }
  }
  #problem(message: string): void {
    const at = this.#host.now();
    const text = this.#host.preview(message, 512);
    this.#host.sink.put("browser:problem", () => ({ type: "browser.problem", at, message: text }));
  }
}
