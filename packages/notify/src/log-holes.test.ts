import { afterEach, expect, it } from "vitest";
import { apply, type Fact } from "@ace/core";
import { Event } from "@ace/protocol";
import { setup } from "./notify.test-helper.ts";
import { attachNotifications } from "./index.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

/**
 * A completed turn the service has not seen yet, logged after `deleted` sequence numbers whose
 * events were removed with their thread (deleting a thread deletes its events from the log).
 */
function afterHole(f: ReturnType<typeof setup>, deleted: number) {
  let seq = f.service.cursor() + deleted;
  let id = 0;
  const facts: Fact[] = [
    { type: "turn.started", agent: "root", trigger: "user" },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  ];
  return facts.flatMap((fact) =>
    apply(f.state, fact, { now: 1000, ids: { next: (kind) => `${kind}-late-${++id}` } }).map(
      (payload) =>
        Event.parse({ seq: ++seq, id: `late-${seq}`, threadId: f.threadId, at: 1000, payload }),
    ),
  );
}

it("replay passes events deleted with their thread and still delivers what follows", async () => {
  const f = setup();
  fixtures.push(f);
  const later = afterHole(f, 500);
  const log = [...f.history, ...later];
  const errors: unknown[] = [];
  const listener = attachNotifications(
    f.service,
    {
      readEvents: ({ afterSeq, limit }) =>
        log.filter((event) => event.seq > afterSeq).slice(0, limit),
      subscribe: () => () => {},
    },
    (error) => errors.push(error),
  );
  await listener.tick();
  expect(errors).toEqual([]);
  expect(f.service.cursor()).toBe(later.at(-1)?.seq);
  await f.flush();
  // One alert per device (desktop and phone) for the turn that finished after the hole.
  expect(f.deliveries.map((delivery) => delivery.notification.status)).toEqual(["done", "done"]);
  await listener.close();
});

it("live batches wait for replay instead of failing as gaps while it catches up", async () => {
  const f = setup();
  fixtures.push(f);
  const later = afterHole(f, 500);
  const errors: unknown[] = [];
  let live: ((events: Event[]) => void) | undefined;
  const listener = attachNotifications(
    f.service,
    {
      readEvents: () => [],
      subscribe: (listen) => {
        live = listen;
        return () => {};
      },
    },
    (error) => errors.push(error),
  );
  // Replay has not run yet, so this batch does not follow on from the cursor. Live ingestion
  // pauses quietly and leaves those events to replay; nothing is reported as a failure.
  live?.(later);
  expect(errors).toEqual([]);
  await listener.close();
});
