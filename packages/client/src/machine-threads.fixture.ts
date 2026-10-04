/** Controllable decoded sidebar boundary: snapshots, errors and deltas need no timers. */
import { ClientError, Notifications, type SidebarSource } from "./index.ts";
import { MachineEntry, MachineThreads } from "./machines.ts";
import { ThreadListView, ThreadListEntry } from "@ace/protocol";

export function sidebarBoundary() {
  let view: ThreadListView | undefined;
  let error: ClientError | undefined;
  const notifications = new Notifications(4096);
  const source: SidebarSource = {
    get error() { return error; },
    get loaded() { return view !== undefined; },
    get ids() { return Object.keys(view?.threads ?? {}); },
    thread(id) { return view?.threads[id]; },
    observe: (listener) => notifications.tap(listener),
    select: (keys, read, equal) => notifications.select(keys, () => read(source), equal),
  };
  return {
    lease: { store: source, release() {} },
    snapshot(value: unknown) {
      view = ThreadListView.parse(value);
      error = undefined;
      notifications.emitAll();
    },
    fail() {
      error = new ClientError("daemon", "Snapshot unavailable");
      notifications.emit(["error"]);
    },
    delta(value: unknown) {
      const row = ThreadListEntry.parse(value);
      if (!view) throw new Error("Snapshot required");
      view.threads[row.id] = row;
      notifications.emit([`thread:${row.id}`, "threads"]);
    },
  };
}
export const entry = (hostId = "laptop") => MachineEntry.parse({
  hostId, displayName: hostId, deviceId: "device", target: { kind: "direct", url: `ws://${hostId}.test/` },
});
export function mergedBoundary() {
  const store = new MachineThreads();
  const sidebar = sidebarBoundary();
  store.attach(entry(), sidebar.lease);
  return { store, sidebar };
}
