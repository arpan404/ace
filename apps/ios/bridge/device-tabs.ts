import { z } from "zod";
import {
  listenPorts,
  loopbackPort,
  loopbackProblemWords,
  nextLoopbackHold,
  noLoopbackHold,
  type LoopbackHold,
  type LoopbackHoldEvent,
  type LoopbackProblem,
} from "@ace/ui-core/device-loopback";
import { parseAddress } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { DeviceLoopback, type LoopbackHost } from "./device-loopback.ts";
import type { MachineTunnel } from "./machine-tunnel.ts";

/*
 * A machine's device tabs on the phone (ADR 0194): pages the person opens run in the phone's own
 * web view, and a page on the machine's localhost reaches it through the tunnel. Swift draws the
 * pages and reports what they do; this decides which tabs exist, whether this machine holds the
 * phone's loopback ports, which ports to listen on, and what a failed page says.
 */

const tabId = z.string().min(1).max(64);
const url = z.string().min(1).max(8192);
export const DeviceTabAction = z.discriminatedUnion("kind", [
  /** A new device tab: typed text (`parseAddress`) or an agent tab's address ("Open on this phone"). */
  z.object({ kind: z.literal("open"), address: url }),
  /** Typed text for the shown tab: it loads there. */
  z.object({ kind: z.literal("navigate"), tabId, address: url }),
  z.object({ kind: z.literal("close"), tabId }),
  /** The page went somewhere, or its title changed. */
  z.object({
    kind: z.literal("page"),
    tabId,
    url,
    title: z.string().max(512).optional(),
  }),
  /** The tab is in front on the phone. */
  z.object({ kind: z.literal("front"), tabId }),
]);
export type DeviceTabAction = z.infer<typeof DeviceTabAction>;
export const DeviceTabControl = z.object({
  type: z.literal("device.tab"),
  action: DeviceTabAction,
});

interface Tab {
  id: string;
  url: string;
  title: string;
  /** Counts the loads asked of the page; Swift loads `url` whenever it goes up. */
  load: number;
}

export interface DeviceTabsOptions {
  sink: PatchSink;
  host: LoopbackHost;
  /** Opens the machine's tunnel; called when the first device tab opens. */
  tunnel: () => MachineTunnel | undefined;
  id: () => string;
}

export class DeviceTabs {
  readonly #options: DeviceTabsOptions;
  readonly #tabs: Tab[] = [];
  #hold: LoopbackHold = noLoopbackHold;
  #tunnel: MachineTunnel | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #busy = new Set<number>();
  readonly #problems = new Map<number, LoopbackProblem>();
  /** The ports last asked of Swift, and whether that answer is still pending. */
  #asked: number[] = [];
  #listening: number[] = [];
  #asking: Promise<void> | undefined;
  readonly loopback: DeviceLoopback;
  /** The last open's refusal of what was typed, for the address bar. */
  #refused: string | undefined;

  constructor(options: DeviceTabsOptions) {
    this.#options = options;
    this.loopback = new DeviceLoopback(options.host, () => this.#tunnel, {
      port: (port, problem) => {
        if (
          problem === undefined
            ? !this.#problems.delete(port)
            : this.#problems.get(port) === problem
        )
          return;
        if (problem !== undefined) this.#problems.set(port, problem);
        this.#emit();
      },
      released: () => this.#holdEvent({ kind: "released" }),
    });
  }

  handle(action: DeviceTabAction): void {
    switch (action.kind) {
      case "open": {
        const parsed = this.#parse(action.address);
        if (parsed === undefined) return;
        this.#tabs.push({ id: this.#options.id(), url: parsed, title: "", load: 1 });
        this.#tabsChanged();
        return;
      }
      case "navigate": {
        const tab = this.#tabs.find((entry) => entry.id === action.tabId);
        if (!tab) return;
        const parsed = this.#parse(action.address);
        if (parsed === undefined) return;
        tab.url = parsed;
        tab.title = "";
        tab.load++;
        this.#plan();
        this.#emit();
        return;
      }
      case "close": {
        const at = this.#tabs.findIndex((tab) => tab.id === action.tabId);
        if (at < 0) return;
        this.#tabs.splice(at, 1);
        this.#tabsChanged();
        return;
      }
      case "page": {
        const tab = this.#tabs.find((entry) => entry.id === action.tabId);
        if (!tab) return;
        const moved = tab.url !== action.url;
        tab.url = action.url;
        if (action.title !== undefined) tab.title = action.title;
        if (moved) this.#plan();
        this.#emit();
        return;
      }
      case "front":
        if (this.#tabs.some((tab) => tab.id === action.tabId)) this.#holdEvent({ kind: "front" });
        return;
    }
  }

  /** The address typed text names, or undefined with the reason kept for the address bar. */
  #parse(address: string): string | undefined {
    const parsed = parseAddress(address);
    this.#refused = parsed.ok ? undefined : parsed.reason;
    if (!parsed.ok) this.#emit();
    return parsed.ok ? parsed.url : undefined;
  }

  /** The machine's runtime stops: listeners go, connections end, the tunnel closes. */
  close(): void {
    this.#tabs.length = 0;
    this.loopback.close();
    this.#tabsChanged();
  }

  #tabsChanged(): void {
    if (this.#tabs.length > 0 && !this.#tunnel) {
      this.#tunnel = this.#options.tunnel();
      this.#unsubscribe = this.#tunnel?.ports.subscribe(() => this.#plan());
    }
    this.#holdEvent({ kind: "tabs", count: this.#tabs.length });
    if (this.#tabs.length === 0 && this.#tunnel) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#tunnel.close();
      this.#tunnel = undefined;
      this.#problems.clear();
    }
    this.#emit();
  }

  #holdEvent(event: LoopbackHoldEvent): void {
    const before = this.#hold.holding;
    this.#hold = nextLoopbackHold(this.#hold, event);
    // A fresh hold tries busy ports again: whatever held them may have let go.
    if (!before && this.#hold.holding) this.#busy.clear();
    if (before !== this.#hold.holding) {
      // Released by another machine: Swift already closed these listeners.
      if (event.kind === "released") this.#asked = this.#listening = [];
      this.#plan();
      this.#emit();
    }
  }

  #pagePorts(): number[] {
    const ports: number[] = [];
    for (const tab of this.#tabs) {
      const port = loopbackPort(tab.url);
      if (port !== undefined) ports.push(port);
    }
    return ports;
  }

  /** Asks Swift for the ports this machine should listen on now, one request at a time. */
  #plan(): void {
    const ports = this.#hold.holding
      ? listenPorts({
          machinePorts: this.#tunnel?.ports.get() ?? [],
          pagePorts: this.#pagePorts(),
          busy: this.#busy,
        })
      : [];
    if (same(ports, this.#asked)) return;
    this.#asked = ports;
    if (this.#asking) return;
    this.#asking = this.#options.host
      .listen(ports)
      .then(
        (answer) => {
          this.#listening = answer.listening;
          for (const port of answer.busy) this.#busy.add(port);
        },
        () => {
          this.#listening = [];
        },
      )
      .finally(() => {
        this.#asking = undefined;
        const answered = ports;
        // Asked again while this was pending, or a busy port leaves the plan: ask once more.
        this.#asked = answered;
        this.#plan();
        this.#emit();
      });
  }

  #emit(): void {
    const busy = this.#busy;
    const holding = this.#hold.holding;
    const problems = this.#problems;
    const tabs = this.#tabs.map((tab) => {
      const port = loopbackPort(tab.url);
      const problem =
        port === undefined
          ? undefined
          : holding && busy.has(port)
            ? ("busy" as const)
            : problems.get(port);
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        load: tab.load,
        problem: problem && port !== undefined ? loopbackProblemWords(problem, port) : null,
      };
    });
    const refused = this.#refused ?? null;
    const listening = [...this.#listening];
    this.#options.sink.put("device.tabs", () => ({
      type: "device.tabs",
      tabs,
      holding,
      listening,
      refused,
    }));
  }
}

function same(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
