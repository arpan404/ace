import { documentVisibility, type PageVisibility } from "./page-visibility.ts";

/**
 * When a side channel (devices, screen) should try again after it drops. A background tab's
 * timers slow to about once a minute, so its keep-alive can miss the daemon's idle window
 * and the channel closes while nobody looks: that has to heal by itself.
 *
 * The first retry after a drop is immediate and silent. Later ones back off and the drop shows.
 * While the page is hidden nothing retries; showing the page or coming back online retries now.
 */
export interface ChannelReconnect {
  /** The channel is up: the next drop starts over with a silent retry. */
  up(): void;
  /** The channel dropped or an attempt failed. Returns whether to keep quiet about it for now. */
  down(): boolean;
  dispose(): void;
}

export interface ChannelReconnectOptions {
  reconnect(): void;
  schedule(callback: () => void, delayMs: number): () => void;
  visibility?: PageVisibility;
  /** Calls `changed` when the network may be back. */
  online?(changed: () => void): () => void;
  /** Waits before the second, third, … retry; the last repeats. */
  delaysMs?: readonly number[];
}

const backoff = [1000, 3000, 10_000, 30_000] as const;

/** The browser's `online` event. */
export function windowOnline(changed: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", changed);
  return () => window.removeEventListener("online", changed);
}

export function channelReconnect(options: ChannelReconnectOptions): ChannelReconnect {
  const visibility = options.visibility ?? documentVisibility;
  const delays = options.delaysMs ?? backoff;
  let failures = 0;
  let waiting = false;
  let cancel: (() => void) | undefined;
  const stopTimer = () => {
    cancel?.();
    cancel = undefined;
  };
  const fire = () => {
    stopTimer();
    if (!waiting) return;
    waiting = false;
    options.reconnect();
  };
  const wake = () => {
    if (waiting && visibility.visible()) fire();
  };
  const unwatchVisibility = visibility.watch(wake);
  const unwatchOnline = (options.online ?? windowOnline)(wake);
  return {
    up() {
      failures = 0;
      waiting = false;
      stopTimer();
    },
    down() {
      stopTimer();
      failures++;
      waiting = true;
      if (visibility.visible()) {
        const delay = failures === 1 ? 0 : (delays[Math.min(failures - 2, delays.length - 1)] ?? 0);
        cancel = options.schedule(fire, delay);
      }
      return failures === 1;
    },
    dispose() {
      waiting = false;
      stopTimer();
      unwatchVisibility();
      unwatchOnline();
    },
  };
}
