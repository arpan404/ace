import { subscribeLockedUse, type ClientCore } from "@ace/client";
import {
  LockedUseResult,
  UserBrowserSettingsResult,
  type HostPlatform,
  type LockedUseStatus,
  type UserBrowserConnection,
  type UserBrowserStatus,
} from "@ace/protocol";
import { lockedUseLabel, lockedUseRefusal, lockedUseShown, lockedUseSwitchOn } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import type { Schedule } from "./browser-live.ts";

/*
 * Settings › Computer use on the phone, beside the apps agents use: locked computer use (opt-in,
 * macOS; let agents work while the Mac is locked, PR #1449) and Use my Chrome (ADR 0084; agents
 * work in tabs of the person's own Chrome). The daemon decides; this reads its state, follows
 * it while the screen is open, and asks for one change at a time. A refusal comes back as the
 * web's sentence. Pure presentation lives in `@ace/ui-core` (`locked-use.ts`).
 */

export const ComputerAccessControl = z.object({
  type: z.literal("computer.access"),
  action: z.discriminatedUnion("kind", [
    /**
     * The screen opened; `mac`: the machine shares app windows the macOS way, the guess used
     * only for an older daemon that doesn't say its platform.
     */
    z.object({ kind: z.literal("open"), mac: z.boolean().optional() }),
    z.object({ kind: z.literal("close") }),
    z.object({ kind: z.literal("locked"), op: z.enum(["install", "remove", "repair", "recheck"]) }),
    z.object({ kind: z.literal("chrome"), op: z.enum(["install", "stop", "revoke"]) }),
  ]),
});
export type ComputerAccessControl = z.infer<typeof ComputerAccessControl>;

/** Browsers connect and tabs change outside ace: the open screen reads Use my Chrome this often. */
const chromePollMs = 3_000;

const familyNames: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  chromium: "Chromium",
  arc: "Arc",
  vivaldi: "Vivaldi",
  opera: "Opera",
};

/** "Chrome 131": a connected browser by family and major version. */
export function connectionTitle(connection: UserBrowserConnection): string {
  const name = familyNames[connection.browser.family] ?? "Browser";
  const major = connection.browser.version.split(".")[0];
  return major ? `${name} ${major}` : name;
}
/** "2 shared · 1 in use by agents". */
export function connectionSummary(connection: UserBrowserConnection): string {
  const controlled = connection.tabs.filter((tab) => tab.attached).length;
  const shared = connection.tabs.filter((tab) => tab.access === "shared").length;
  if (!connection.tabs.length) return "No tabs shared";
  const parts = [`${shared} shared`];
  if (controlled) parts.push(`${controlled} in use by agents`);
  return parts.join(" · ");
}

/**
 * Whether the machine is a Mac, for locked use: what the daemon says it runs on, or for an older
 * daemon that doesn't say, how it shares app windows.
 */
export function hostIsMac(host: {
  platform: HostPlatform | undefined;
  sharesLikeMac: boolean;
}): boolean {
  return host.platform ? host.platform === "darwin" : host.sharesLikeMac;
}

/**
 * Locked use as the row draws it: the Mac's state in a word and tone, and what the person can do.
 * A machine that says it isn't a Mac never offers it, whatever state it reports.
 */
export function lockedUseRow(
  status: LockedUseStatus,
  host: { platform: HostPlatform | undefined; sharesLikeMac: boolean },
) {
  if (host.platform && host.platform !== "darwin") return null;
  if (!lockedUseShown({ screenUnavailable: false, status, hostIsMac: hostIsMac(host) }))
    return null;
  const { label, tone } = lockedUseLabel(status);
  return {
    label,
    tone,
    on: lockedUseSwitchOn(status),
    busy: status.state === "installing",
    repair: status.state === "driftRepairNeeded",
    /** Said under the row: why it failed or drifted, or that macOS waits for approval. */
    note:
      status.state === "installFailed" || status.state === "driftRepairNeeded"
        ? String(status.reason)
        : status.state === "needsApproval"
          ? "Approve it in System Settings on the Mac, then check again."
          : null,
  };
}

/** Use my Chrome as its section draws it. */
export function chromeSection(status: UserBrowserStatus, preview: Preview) {
  const installed = status.installed.length > 0;
  return {
    supported: status.supported,
    installed,
    installedFor: status.installed.map((host) => preview(host.browser, 64)),
    extensionPath: status.extensionPath ? preview(status.extensionPath, 1024) : null,
    connections: status.connections.map((connection) => ({
      id: connection.connectionId,
      title: connectionTitle(connection),
      summary: connectionSummary(connection),
    })),
    controlled: status.connections.some((connection) =>
      connection.tabs.some((tab) => tab.attached),
    ),
  };
}

export class ComputerAccess {
  #owner: Pick<ClientCore, "request" | "state" | "connectionState" | "onMessage">;
  #sink: PatchSink;
  #preview: Preview;
  #schedule: Schedule;
  #id: () => string;
  #open: { mac: boolean } | undefined;
  #locked: LockedUseStatus | undefined;
  #lockedFailed = false;
  #chrome: UserBrowserStatus | undefined;
  #busy: string | undefined;
  #error: string | undefined;
  #subscription: { retry(): void; stop(): void } | undefined;
  #poll: (() => void) | undefined;
  #watching: (() => void) | undefined;
  /** What the daemon said it runs on; undefined until read, or from an older daemon. */
  #platform: { value: HostPlatform | undefined } | undefined;
  constructor(
    owner: Pick<ClientCore, "request" | "state" | "connectionState" | "onMessage">,
    sink: PatchSink,
    preview: Preview,
    schedule: Schedule,
    id: () => string,
  ) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#schedule = schedule;
    this.#id = id;
  }
  handle(control: ComputerAccessControl): void {
    const action = control.action;
    switch (action.kind) {
      case "open":
        this.#open = { mac: action.mac ?? this.#open?.mac ?? false };
        this.#subscription ??= this.#subscribe();
        if (!this.#watching) {
          // A connection that comes back (or wasn't ready yet) reads Use my Chrome at once.
          const connection = this.#owner.connectionState();
          this.#watching = connection.subscribe(() => {
            // Another connection may be another daemon: its platform is read again.
            if (connection.getSnapshot() !== "ready") {
              this.#platform = undefined;
              return;
            }
            this.#poll?.();
            void this.#readChrome();
            void this.#readPlatform();
          });
        }
        if (!this.#poll) void this.#readChrome();
        if (!this.#platform) void this.#readPlatform();
        this.#put();
        return;
      case "close":
        this.close();
        return;
      case "locked":
        if (action.op === "recheck") {
          this.#subscription?.stop();
          this.#subscription = this.#subscribe();
          return;
        }
        void this.#lockedChange(action.op);
        return;
      case "chrome":
        void this.#chromeChange(action.op);
        return;
    }
  }
  close(): void {
    this.#open = undefined;
    this.#subscription?.stop();
    this.#subscription = undefined;
    this.#poll?.();
    this.#poll = undefined;
    this.#watching?.();
    this.#watching = undefined;
    this.#error = undefined;
  }

  #subscribe() {
    return subscribeLockedUse(
      this.#owner,
      `ios-locked-use-${this.#id()}`,
      (status) => {
        this.#locked = status;
        this.#lockedFailed = false;
        this.#put();
      },
      () => {
        this.#lockedFailed = true;
        this.#put();
      },
      { set: (delay, run) => this.#schedule(delay, run) },
    );
  }
  /** The daemon's own word for its platform; a failed read falls back to the window guess. */
  async #readPlatform(): Promise<void> {
    if (!this.#open || this.#owner.state !== "ready") return;
    try {
      const reply = await this.#owner.request({ type: "host.identity" });
      this.#platform = { value: reply.identity.platform };
    } catch {
      this.#platform = { value: undefined };
    }
    this.#put();
  }
  async #lockedChange(op: "install" | "remove" | "repair"): Promise<void> {
    if (this.#busy) return;
    const title = {
      install: "Couldn't turn on locked use",
      remove: "Couldn't turn off locked use",
      repair: "Couldn't repair locked use",
    }[op];
    this.#busy = `locked.${op}`;
    this.#error = undefined;
    this.#put();
    try {
      // The person's intent is stored first, as the web stores it; the Mac's state follows.
      if (op !== "repair") {
        const saved = await this.#owner.request({
          type: "settings.set",
          key: "computer.lockedUse",
          value: op === "install",
          layer: { kind: "global" },
        });
        if (!saved.ok) throw new Error("Couldn't save that setting.");
      }
      const reply = LockedUseResult.parse(
        await this.#owner.request(
          op === "install"
            ? { type: "lockedUse.install" }
            : op === "remove"
              ? { type: "lockedUse.remove" }
              : { type: "lockedUse.repair" },
        ),
      );
      if (reply.status) this.#locked = reply.status;
      if (!reply.ok) this.#error = `${title}. ${lockedUseRefusal(reply.code, reply.reason)}`;
    } catch (error) {
      this.#error = `${title}. ${error instanceof Error ? error.message : lockedUseRefusal(undefined, undefined)}`;
    } finally {
      this.#busy = undefined;
      this.#put();
    }
  }
  async #readChrome(): Promise<void> {
    this.#poll = undefined;
    if (!this.#open) return;
    if (this.#owner.state === "ready") {
      const status = await this.#chromeRequest("status").catch(() => undefined);
      if (status && this.#open) {
        this.#chrome = status;
        this.#put();
      }
    }
    if (this.#open && !this.#poll)
      this.#poll = this.#schedule(chromePollMs, () => void this.#readChrome());
  }
  async #chromeChange(op: "install" | "stop" | "revoke"): Promise<void> {
    if (this.#busy) return;
    this.#busy = `chrome.${op}`;
    this.#error = undefined;
    this.#put();
    try {
      this.#chrome = await this.#chromeRequest(op);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "Use my Chrome failed.";
    } finally {
      this.#busy = undefined;
      this.#put();
    }
  }
  async #chromeRequest(
    operation: "status" | "install" | "stop" | "revoke",
  ): Promise<UserBrowserStatus> {
    const reply = UserBrowserSettingsResult.parse(
      await this.#owner.request({ type: "user_browser.settings", operation }),
    );
    if (reply.result.kind === "error") throw new Error(reply.result.message);
    return reply.result.status;
  }
  #put(): void {
    const open = this.#open;
    if (!open) return;
    const locked = this.#locked;
    const chrome = this.#chrome;
    const preview = this.#preview;
    this.#sink.put("computer:access", () => ({
      type: "computer.access",
      // Nothing until the daemon has said what it runs on, so a Windows machine never flashes it.
      locked:
        locked && this.#platform
          ? lockedUseRow(locked, { platform: this.#platform.value, sharesLikeMac: open.mac })
          : null,
      lockedFailed: this.#lockedFailed && !locked,
      chrome: chrome ? chromeSection(chrome, preview) : null,
      /** What the daemon said it runs on; null until read, or from an older daemon. */
      platform: this.#platform?.value ?? null,
      busy: this.#busy ?? null,
      error: this.#error ? preview(this.#error, 512) : null,
    }));
  }
}
