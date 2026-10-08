/** Card keys shared by the sidebar rows, the Needs-you cards and `/activity?item=`. */
export const interactionKey = (threadId: string, interactionId: string) =>
  `interaction:${threadId}:${interactionId}`;
export const eventKey = (eventId: string) => `event:${eventId}`;
export const runKey = (runId: string) => `run:${runId}`;
/** The read-state id behind a card key: an event's or a run's own id. */
export function readIdOf(key: string): string | undefined {
  if (key.startsWith("event:")) return key.slice("event:".length);
  if (key.startsWith("run:")) return key.slice("run:".length);
  return undefined;
}
