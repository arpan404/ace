import { z } from "zod";

/*
 * Where a thread-screen action goes. SwiftUI tears a thread's views down after the person has
 * already left it (a "Worked for" log's onDisappear, a lane sheet closing), so their releases
 * reach the bridge once the session is gone or another generation is open. A release or read
 * of a closed generation has nothing left to do and is dropped. An action the person submitted
 * (it carries a requestId) is refused on its own admission, so its control recovers; neither
 * raises the runtime-wide error.
 */

export interface RoutedSession {
  readonly epoch: number;
  handle(raw: unknown): void;
}
type Put = (key: string, read: () => Record<string, unknown>) => void;

const Submitted = z.object({ requestId: z.string().min(1).max(64) });
export const closedThread = "That thread was closed. Open it again to continue.";

/** `epoch` is the generation the action was sent for; absent when Swift had no thread open. */
export function routeThreadAction(
  session: RoutedSession | undefined,
  epoch: number | undefined,
  raw: unknown,
  put: Put,
): void {
  if (session && epoch === session.epoch) {
    session.handle(raw);
    return;
  }
  const submitted = Submitted.safeParse(raw);
  if (!submitted.success) return;
  const id = submitted.data.requestId;
  put(`admission:${id}`, () => ({ type: "admission", id, ok: false, message: closedThread }));
}
