import { expect, test } from "vitest";
import { attachmentReadScope } from "./attachment-scope.ts";
import { Notifications } from "./observable.ts";
import type { ConnectionState } from "./types.ts";

/** A client whose socket generation is watched through the same listener budget as the real one. */
function client(listeners: number) {
  const notifications = new Notifications(listeners);
  const at: { state: ConnectionState; socket: number } = { state: "ready", socket: 1 };
  return {
    get state() {
      return at.state;
    },
    connectionGeneration: () =>
      notifications.select(["connection", "socket"], () =>
        at.state === "ready" ? at.socket : undefined,
      ),
    move() {
      at.socket++;
      notifications.emit(["socket"]);
    },
  };
}

test("a read nested in another read of the same client fits one read's listeners and still ends when the socket moves", () => {
  const c = client(2);
  const outer = attachmentReadScope(c);
  const inner = attachmentReadScope(c, outer.signal);
  expect(inner.signal.aborted).toBe(false);
  c.move();
  expect(outer.signal.aborted).toBe(true);
  expect(inner.signal.aborted).toBe(true);
  inner.close();
  outer.close();
  // Both closed: the budget is whole again for the next read.
  expect(attachmentReadScope(c).signal.aborted).toBe(false);
});

test("a caller's own signal still binds the read to the socket it started on", () => {
  const c = client(2);
  const caller = new AbortController();
  const scope = attachmentReadScope(c, caller.signal);
  expect(() => attachmentReadScope(c, caller.signal)).toThrow("limit");
  c.move();
  expect(scope.signal.aborted).toBe(true);
  scope.close();
});

test("a read started from a closed scope's signal binds to the socket itself", () => {
  const c = client(2);
  const outer = attachmentReadScope(c);
  outer.close();
  const later = attachmentReadScope(c, outer.signal);
  c.move();
  expect(later.signal.aborted).toBe(true);
  later.close();
});
