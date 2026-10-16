import { FactBatch, type Fact, type IdSource } from "@ace/core";
import type { EventPayload } from "@ace/protocol";
import type { Snapshot } from "./persistence.ts";

/** Streaming uses the canonical reducer; the repository owns its eventual commit. */
export function streamFacts(
  snapshot: Snapshot,
  facts: Fact[],
  now: number,
  ids: IdSource,
): EventPayload[] {
  snapshot.begin();
  const batch = new FactBatch(snapshot.state, { deadline: snapshot.deadline() });
  const events: EventPayload[] = [];
  for (const fact of facts) {
    const finish = snapshot.prepare(fact);
    try {
      const emitted = batch.apply(fact, { now, ids });
      if (fact.type === "item.delta" && emitted.some((event) => event.type === "item.delta"))
        snapshot.delta(fact);
      snapshot.remember(fact, emitted);
      events.push(...emitted);
    } finally {
      finish();
    }
  }
  events.push(...batch.flush());
  snapshot.updateDeadlines(facts, events, now);
  snapshot.retainChanges(events);
  return events;
}
