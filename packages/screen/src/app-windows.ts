import { ScreenAppWindows, ScreenInventory, type ScreenAgentScope } from "@ace/protocol";
import type { HelperHost } from "./helper-host.ts";
import { HelperCommandError } from "./helper.ts";
import { nodeScheduler } from "./runtime.ts";
import type { ScreenOptions } from "./options.ts";

/** The helper resolves native identity. Launch readiness retries never choose an arbitrary window. */
export class AppWindows {
  constructor(
    privateHost: HelperHost,
    authorize: (bundleId: string, caller?: ScreenAgentScope) => void,
    scheduler: NonNullable<ScreenOptions["scheduler"]> = nodeScheduler,
  ) {
    this.host = privateHost;
    this.authorize = authorize;
    this.scheduler = scheduler;
  }
  private readonly host: HelperHost;
  private readonly authorize: (bundleId: string, caller?: ScreenAgentScope) => void;
  private readonly scheduler: NonNullable<ScreenOptions["scheduler"]>;
  async list(bundleId: string, caller?: ScreenAgentScope): Promise<ScreenAppWindows> {
    this.authorize(bundleId, caller);
    const helper = await this.host.open();
    let result: ScreenAppWindows;
    try {
      if (helper.capabilities?.platform !== "macos" || !helper.capabilities.windowSelection)
        throw new HelperCommandError("not_supported", "Native resolver is unavailable");
      result = ScreenAppWindows.parse(
        await helper.request({ op: "windows.list", bundleId, allowlist: [bundleId] }, () =>
          this.authorize(bundleId, caller),
        ),
      );
    } catch (error) {
      if (!(error instanceof HelperCommandError) || error.code !== "not_supported") throw error;
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      const windows = inventory.windows.filter((window) => window.bundleId === bundleId);
      result = {
        windows,
        ...(windows.length === 1 ? { selectedWindowId: windows[0]?.windowId } : {}),
      };
    }
    if (
      result.windows.some((window) => window.bundleId !== bundleId) ||
      (result.selectedWindowId !== undefined &&
        !result.windows.some(
          (window) => window.windowId === result.selectedWindowId && window.usable !== false,
        ))
    )
      throw new Error("Invalid helper window selection");
    this.authorize(bundleId, caller);
    return result;
  }
  async ready(
    bundleId: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
    windowId?: number,
  ): Promise<ScreenAppWindows> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const result = await this.list(bundleId, caller);
      signal.throwIfAborted();
      const candidates = result.windows.filter((window) => window.usable !== false);
      if (windowId !== undefined) {
        if (!candidates.some((candidate) => candidate.windowId === windowId))
          throw new HelperCommandError(
            "target_gone",
            "Selected app window is unavailable",
            "rejected-before-dispatch",
          );
        return { ...result, selectedWindowId: windowId };
      }
      if (result.selectedWindowId !== undefined) return result;
      if (candidates.length > 1)
        throw new HelperCommandError(
          "window_ambiguous",
          "Select a target window from the app's candidates",
          "rejected-before-dispatch",
          candidates.map(({ bounds, ...candidate }) => ({
            ...candidate,
            ...(bounds
              ? { bounds: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } }
              : {}),
          })),
        );
      if (candidates.length === 1) return { ...result, selectedWindowId: candidates[0]?.windowId };
      if (attempt === 6) return result;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cancel();
          reject(signal.reason);
        };
        const cancel = this.scheduler.schedule(
          () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          Math.min(25 * 2 ** attempt, 200),
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
