import { spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { screen, type Rectangle } from "electron";
import type { DeepLink, NativeTrayAppearance } from "../../shared/contract.ts";
import type { DesktopLink } from "../link/desktop-link.ts";
import { TrayAction, TrayTab } from "./native-tray-action.ts";
import type { TrayUsagePreferences } from "./native-tray-model.ts";
import { popoverBounds, reopensOnClick } from "./tray-popover-place.ts";

interface TrayPopoverOptions {
  executable: string;
  now(): number;
  link(): DesktopLink | undefined;
  appearance(): NativeTrayAppearance | undefined;
  open(link?: DeepLink): void;
  quit(completely: boolean): void;
  tabFile: string;
  usagePreferences(): TrayUsagePreferences | undefined;
  log(message: string): void;
}

type Process = ChildProcessByStdio<Writable, Readable, null>;

/** The Swift panel runs only while it is open. The pipes carry presentation data and actions. */
export class TrayPopover {
  private child: Process | undefined;
  private closedAt: number | undefined;
  private tab: TrayTab = "agents";
  private options: TrayPopoverOptions;

  constructor(options: TrayPopoverOptions) {
    this.options = options;
    try {
      this.tab = TrayTab.parse(readFileSync(options.tabFile, "utf8"));
    } catch {
      // First use starts on Agents.
    }
  }

  toggle(anchor: Rectangle): boolean {
    if (this.child) {
      this.hide();
      return true;
    }
    if (!reopensOnClick(this.closedAt, this.options.now())) return true;
    try {
      accessSync(this.options.executable, constants.X_OK);
    } catch {
      return false;
    }
    const area = screen.getDisplayMatching(anchor).workArea;
    const { x, y, width, height } = popoverBounds(anchor, area, 510);
    const child = spawn(
      this.options.executable,
      [String(x), String(y), String(width), String(height), this.tab],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    this.child = child;
    const abort = new AbortController();
    const reader = createInterface({ input: child.stdout });
    let busy = false;
    let pending = false;
    let revision = 0;
    let previous: string | undefined;
    let problem: string | undefined;
    const refresh = async () => {
      if (abort.signal.aborted || busy || pending || child.stdin.writableNeedDrain) return;
      busy = true;
      const asked = revision;
      const tab = this.tab;
      try {
        const link = this.options.link();
        const snapshot = await link?.traySnapshot(
          tab,
          this.options.now(),
          AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]),
          this.options.usagePreferences(),
        );
        if (abort.signal.aborted || asked !== revision || link !== this.options.link()) return;
        const message = JSON.stringify({
          ...snapshot,
          tab,
          appearance: this.options.appearance(),
          problem,
        });
        if (message !== previous) {
          previous = message;
          child.stdin.write(message + "\n");
        }
      } catch (error) {
        if (!abort.signal.aborted) this.options.log(`Native tray: ${String(error)}`);
      } finally {
        busy = false;
      }
    };
    const handle = async (action: Exclude<TrayAction, { action: "tab" }>) => {
      switch (action.action) {
        case "thread":
          this.options.open({ kind: "thread", threadId: action.id });
          break;
        case "open":
          this.options.open();
          break;
        case "usage":
          this.options.open({ kind: "usage" });
          break;
        case "settings":
          this.options.open({ kind: "settings", page: "computer-use" });
          break;
        case "quit":
        case "quitCompletely":
          this.options.quit(action.action === "quitCompletely");
          return;
        default: {
          const link = this.options.link();
          if (!link) throw new Error("The daemon is offline");
          await link.trayAction(action, abort.signal);
          return;
        }
      }
      this.hide();
    };
    const refreshSoon = () => {
      void refresh().catch((error: unknown) => this.options.log(`Native tray: ${String(error)}`));
    };
    const timer = setInterval(refreshSoon, 1_000);
    const close = () => {
      abort.abort();
      clearInterval(timer);
      reader.close();
      if (this.child === child) {
        this.child = undefined;
        this.closedAt = this.options.now();
      }
    };
    child.on("error", (error) => {
      this.options.log(`Native tray: ${error.message}`);
      close();
    });
    child.stdin.on("error", () => child.kill());
    child.once("close", close);
    reader.on("line", (line) => {
      if (abort.signal.aborted || line.length > 1024) return;
      let action: TrayAction;
      try {
        action = TrayAction.parse(JSON.parse(line));
      } catch {
        return;
      }
      if (pending && action.action !== "tab") return;
      revision++;
      problem = undefined;
      if (action.action === "tab") {
        this.tab = action.tab;
        void writeFile(this.options.tabFile, action.tab).catch(() => {});
        refreshSoon();
        return;
      }
      pending = true;
      void handle(action)
        .catch((error: unknown) => {
          problem = error instanceof Error ? error.message : "Couldn’t complete the action";
        })
        .finally(() => {
          pending = false;
          refreshSoon();
        });
    });
    refreshSoon();
    return true;
  }

  hide(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.closedAt = this.options.now();
    child.stdin.end();
    child.kill();
  }
}
