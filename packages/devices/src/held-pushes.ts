import type { DeviceServerMessage } from "@ace/protocol/devices";

/** Replaceable pushes: only the latest of each needs to reach a client. */
function replaceKey(message: DeviceServerMessage): string | undefined {
  if (message.type === "devices.state") return `state:${message.state.device.id}`;
  if (message.type === "devices.inventory" || message.type === "devices.enabled")
    return message.type;
  return undefined;
}

/**
 * A devices channel's outgoing messages before its socket has said welcome. The channel can
 * subscribe early (so a full subscriber budget refuses the hello), but nothing reaches the
 * client until `open`: then the opening snapshot goes first, followed by every change that came
 * in while it waited (the latest of each replaceable push), in the order they happened.
 */
export function heldPushes(write: (message: DeviceServerMessage) => Promise<void>) {
  let held: Map<string, DeviceServerMessage> | undefined = new Map();
  let serial = 0;
  return {
    send(message: DeviceServerMessage): Promise<void> {
      if (!held) return write(message);
      // Before welcome no request can have arrived, so this holds pushes, and stays small: at
      // most one per device, plus inventory and enablement.
      if (held.size >= 64)
        return Promise.reject(new Error("Too many device pushes before welcome"));
      const key = replaceKey(message) ?? `once:${++serial}`;
      held.delete(key);
      held.set(key, message);
      return Promise.resolve();
    },
    /** Welcome went out: send the snapshot, then what waited. Later sends go straight through. */
    open(snapshot: DeviceServerMessage[]): Promise<void> {
      if (!held) return Promise.resolve();
      const waiting = [...held.values()];
      held = undefined;
      return Promise.all([...snapshot, ...waiting].map(write)).then(() => {});
    },
  };
}
