/** What an agent waits on the person for, as Spade's roster sends it (`pending`), from its events. */

type Json = Record<string, unknown>;

/** Each approval and question still open in `events`, in the order asked. */
export function fakeSpadePending(events: readonly Json[]): Json[] {
  const closed = new Set(
    events
      .filter((event) =>
        [
          "approval_answered",
          "question_answered",
          "question_dismissed",
          "question_deferred",
        ].includes(String(event.type)),
      )
      .map((event) => String(event.call_id)),
  );
  const open: Json[] = [];
  for (const event of events) {
    if (closed.has(String(event.call_id))) continue;
    if (event.type === "approval_requested") {
      open.push({
        kind: "approval",
        name: event.name,
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
        ...(event.effect === undefined ? {} : { effect: event.effect }),
        ...(event.reviewer_reason === undefined ? {} : { reviewer_reason: event.reviewer_reason }),
      });
    } else if (event.type === "question_asked") {
      const cards = Array.isArray(event.questions) ? (event.questions as Json[]) : [];
      if (!cards.length) open.push({ kind: "question", prompt: String(event.question ?? "") });
      for (const card of cards)
        open.push(
          card.kind === "connect"
            ? { kind: "connect", app: card.name ?? card.app }
            : { kind: "question", prompt: String(card.prompt ?? "") },
        );
    }
  }
  return open;
}
