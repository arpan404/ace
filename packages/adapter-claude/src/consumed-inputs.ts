import type { Frame } from "@ace/engine-api";
import { list, string, type Data } from "./native.ts";
import type { ClaudeState } from "./state.ts";

const limit = 256;

/**
 * Claude stamps each main-thread reply frame with `user_message_uuids`: the client uuids of
 * every user message the frame's turn has consumed so far, including a batch merged into one
 * turn and messages folded in between tool rounds (SDK `SDKAssistantMessage` and
 * `SDKPartialAssistantMessage` docs). That is which turn took a steer, even one that arrived
 * as the previous turn ended. Each uuid is reported once, after the frame's own turn start.
 */
export class ConsumedInputs {
  private readonly reported = new Set<string>();
  observe(state: ClaudeState, frame: Frame, data: Data): void {
    if (frame.channel !== "sdk" || frame.dir !== "recv") return;
    const type = string(data["type"]);
    if (type !== "assistant" && type !== "stream_event") return;
    if (string(data["parent_tool_use_id"]) || !state.active.has(state.root)) return;
    const uuids = list(data["user_message_uuids"]);
    const fresh = [...(uuids.length ? uuids : [data["user_message_uuid"]])].filter(
      (uuid): uuid is string =>
        typeof uuid === "string" &&
        uuid.length > 0 &&
        uuid.length <= 512 &&
        !this.reported.has(uuid),
    );
    if (!fresh.length) return;
    for (const uuid of fresh) {
      if (this.reported.size >= limit)
        this.reported.delete(this.reported.values().next().value ?? "");
      this.reported.add(uuid);
    }
    state.emit({ type: "input.consumed", agent: state.root, nativeInputIds: fresh.slice(0, 64) });
  }
}
