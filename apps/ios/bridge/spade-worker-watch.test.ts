import { ClientError, defaultLimits, ThreadStore } from "@ace/client";
import { expect, test } from "vitest";
import { SpadeWorkerWatch } from "./spade-worker-watch.ts";

/*
 * A worker the thread list doesn't hold is read from its own thread, which may be refused for lack
 * of room. The refusal is not kept: the read is tried again when room frees up.
 */

type Owner = ConstructorParameters<typeof SpadeWorkerWatch>[0];

const listed = {
  loaded: true,
  unconfirmed: false,
  syncing: false,
  error: undefined,
  ids: [],
  thread: () => undefined,
  observe: () => () => {},
};

test("a worker whose own thread was refused for lack of room is read again when room frees up", () => {
  let roomFree = false;
  let freed: (() => void) | undefined;
  let acquired = 0;
  const owner = {
    threads: () => ({ store: listed, release: () => {} }),
    thread: () => {
      acquired++;
      const store = new ThreadStore(defaultLimits);
      if (!roomFree) store.fail(new ClientError("no_room", "No room"));
      return { store, release: () => {} };
    },
    threadRoom: () => ({
      getSnapshot: () => 0,
      subscribe: (listener: () => void) => {
        freed = listener;
        return () => {
          freed = undefined;
        };
      },
    }),
  } as unknown as Owner;
  let changes = 0;
  const watch = new SpadeWorkerWatch(owner, () => changes++);
  const facts = () => watch.facts(() => undefined, () => undefined);

  expect(facts().listed("worker")).toBeUndefined();
  expect(freed).toBeDefined();

  roomFree = true;
  freed?.();
  expect(changes).toBe(1);
  // Read again on the next look, not kept from the refusal.
  facts().listed("worker");
  expect(acquired).toBe(2);
  watch.stop();
});
