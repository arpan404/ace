import type { Frame } from "@ace/engine-api";
import { object, string, type Data } from "./native.ts";
import type { ClaudeState } from "./state.ts";

/**
 * Claude takes a steer (a user message sent with priority `now` into a running turn) by aborting
 * the turn's in-flight request and running the steer straight after, as a fresh native turn on the
 * same conversation: the result between them reads `terminal_reason: aborted_*`. The agent never
 * stopped, so that result is not the turn's end: the turn goes on through the steer and ends with
 * the result that follows it. Only a stop the person asked for (an interrupt control request, or a
 * cancelled approval, which Claude also takes as an interrupt) makes an aborted result a stopped
 * turn; a stop always wins over a steer sent in the same stretch.
 */
export class SteerContinuation {
  private steered = false;
  private stopped = false;
  observe(state: ClaudeState, frame: Frame, data: Data): void {
    if (frame.dir !== "send") return;
    const type = string(data["type"]);
    if (
      type === "user" &&
      frame.channel === "sdk" &&
      data["priority"] === "now" &&
      state.active.has(state.root)
    )
      this.steered = true;
    if (type === "control_request" && object(data["request"])["subtype"] === "interrupt")
      this.stopped = true;
    if (
      type === "control_response" &&
      object(object(data["response"])["response"])["interrupt"] === true
    )
      this.stopped = true;
  }
  /** Whether the root's result, aborted, only made way for a steer. Each result settles both. */
  carriesOn(aborted: boolean): boolean {
    const carries = aborted && this.steered && !this.stopped;
    this.steered = false;
    this.stopped = false;
    return carries;
  }
}
