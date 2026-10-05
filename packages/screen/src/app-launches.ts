import { ScreenBundle, ScreenAgentScope } from "@ace/protocol";
import { HelperCommandError } from "./helper.ts";
import type { HelperHost } from "./helper-host.ts";

/** Launch reservations exist before helper startup and remain owned through acknowledgement. */
export class AppLaunches {
  private epoch = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly host: HelperHost;
  private readonly authorize: (bundleId: string, caller?: ScreenAgentScope) => void;
  constructor(host: HelperHost, authorize: (bundleId: string, caller?: ScreenAgentScope) => void) {
    this.host = host;
    this.authorize = authorize;
  }
  open(rawBundle: string, rawCaller?: ScreenAgentScope, signal?: AbortSignal): Promise<unknown> {
    const bundleId = ScreenBundle.parse(rawBundle);
    const caller = rawCaller && ScreenAgentScope.parse(rawCaller);
    signal?.throwIfAborted();
    this.authorize(bundleId, caller);
    if (this.pending.size >= 8) return Promise.reject(new Error("Launch reservation limit"));
    const epoch = this.epoch;
    const validate = () => {
      signal?.throwIfAborted();
      if (epoch !== this.epoch) throw new Error("Screen launch cancelled");
      this.authorize(bundleId, caller);
    };
    const operation = this.host.open().then((helper) =>
      this.host.execute(validate, async () => {
        if (!helper.capabilities?.background)
          throw new HelperCommandError("foreground_required", "Helper cannot launch in background");
        return helper.request({ op: "open.app", bundleId, allowlist: [bundleId] });
      }),
    );
    this.pending.add(operation);
    return operation.finally(() => this.pending.delete(operation));
  }
  invalidate(): void {
    this.epoch++;
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
