import type { DeviceServerMessage } from "@ace/protocol/devices";

/** Coalesce replaceable pushes while frames drain. Replies always remain reliable. */
export function deviceControlDelivery(options: {
  bufferedBytes(): number;
  after(ms: number, run: () => void): () => void;
  write(message: DeviceServerMessage): Promise<void>;
  failure(error: unknown): void;
}) {
  const pending = new Map<string, DeviceServerMessage>();
  let cancel: (() => void) | undefined;
  let closed = false;
  function schedule() {
    if (closed || cancel || !pending.size) return;
    cancel = options.after(25, () => {
      cancel = undefined;
      if (options.bufferedBytes() > 256 * 1024) {
        schedule();
        return;
      }
      const messages = [...pending.values()];
      pending.clear();
      void Promise.all(messages.map(options.write)).catch(options.failure);
    });
  }
  return {
    async send(message: DeviceServerMessage): Promise<void> {
      if (closed) throw new Error("Device connection closed");
      const key =
        message.type === "devices.state"
          ? message.state.device.id
          : message.type === "devices.inventory" || message.type === "devices.enabled"
            ? message.type
            : undefined;
      if (key && (pending.has(key) || options.bufferedBytes() > 256 * 1024)) {
        // The service has at most 32 sessions, plus inventory and enablement.
        pending.set(key, message);
        schedule();
        return;
      }
      if (message.type === "devices.logs" && options.bufferedBytes() > 256 * 1024) return;
      await options.write(message);
    },
    close() {
      closed = true;
      cancel?.();
      pending.clear();
    },
  };
}
