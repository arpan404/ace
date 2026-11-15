import type { Event, Interaction, ThreadView } from "@ace/protocol";
import { summarizeInteraction } from "@ace/projection/interaction-summary";

/*
 * Interactions as clients get them (ADR 0156): one whose request is too large to send with its
 * thread goes as its summary, in snapshots and in live or replayed events. Storage and the
 * engine keep them whole. Snapshot views and published events are shared objects, so each
 * interaction and event is weighed and summarized once, whoever it goes to.
 */

const interactions = new WeakMap<Interaction, Interaction>();
const events = new WeakMap<Event, Event>();

function sent(interaction: Interaction): Interaction {
  let summary = interactions.get(interaction);
  if (summary === undefined) {
    summary = summarizeInteraction(interaction);
    interactions.set(interaction, summary);
  }
  return summary;
}

/** `event` as clients get it: an `interaction.opened` carries its interaction as sent. */
export function wireEvent(event: Event): Event {
  if (event.payload.type !== "interaction.opened") return event;
  let wire = events.get(event);
  if (wire === undefined) {
    const interaction = sent(event.payload.interaction);
    wire =
      interaction === event.payload.interaction
        ? event
        : { ...event, payload: { ...event.payload, interaction } };
    events.set(event, wire);
  }
  return wire;
}

/** `view` as clients get it: a copy whose too-large requests are summaries, else `view` itself. */
export function wireThreadView(view: ThreadView): ThreadView {
  let changed = false;
  const entries = Object.entries(view.interactions).map(([id, interaction]) => {
    const wire = sent(interaction);
    if (wire !== interaction) changed = true;
    return [id, wire] as const;
  });
  // Own data properties for every id, as decoding a record gives (`__proto__` included).
  return changed ? { ...view, interactions: Object.fromEntries(entries) } : view;
}
