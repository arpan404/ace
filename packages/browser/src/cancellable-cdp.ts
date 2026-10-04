import type { BrowserCdp } from "./backend.ts";

/** Session cancellation settles reads even if Chromium's transport stops replying. */
export function cancellableCdp(cdp: BrowserCdp, signal: AbortSignal): BrowserCdp {
  return {
    on: (method, listener) => cdp.on(method, listener),
    off: (method, listener) => cdp.off(method, listener),
    send(method, params) {
      if (signal.aborted) return Promise.reject(new Error("Browser session closed"));
      return new Promise<unknown>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(new Error("Browser session closed"));
        };
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve()
          .then(() => cdp.send(method, params))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    },
  };
}
