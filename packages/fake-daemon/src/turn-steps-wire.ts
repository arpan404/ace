import { toolSurfaces } from "@ace/projection";
import type { Item, ServerMessage, TurnStep, TurnStepsRequest } from "@ace/protocol";
import type { FakeTurnIndex } from "./long-thread-index.ts";
import type { ThreadHost } from "./thread-host.ts";
import type { FakeIcons } from "./icons-wire.ts";

/** `turn.steps` over the fake host's items: the turn's work, oldest first, paged by creation. */
export function fakeTurnSteps(
  host: ThreadHost,
  index: FakeTurnIndex,
  icons: FakeIcons,
  message: TurnStepsRequest,
  seq: number,
): ServerMessage {
  const turn = index.summaries(message.threadId).find((t) => t.ordinal === message.turnOrdinal);
  if (!turn)
    return {
      type: "error",
      requestId: message.requestId,
      code: "turn_target_unavailable",
      message: "turn_target_unavailable",
    };
  const after = message.after ?? 0;
  const matching = host.view.itemOrder.filter((id) => {
    const item = host.view.items[id];
    const created = host.creation.get(id) ?? 0;
    return (
      item !== undefined &&
      created > after &&
      index.itemTurn(id) === message.turnOrdinal &&
      !(item.type === "message" && item.role === "user")
    );
  });
  const page = matching.slice(0, message.limit);
  const steps: TurnStep[] = page.flatMap((id) => {
    const item = host.view.items[id];
    if (!item) return [];
    const light: Item =
      item.type === "tool_call" && item.call.detail.kind !== "custom"
        ? { ...item, call: { ...item.call, raw: [] } }
        : item;
    return [{ seq: host.creation.get(id) ?? 1, item: structuredClone(light) }];
  });
  const surfaces = toolSurfaces(steps.map((step) => step.item));
  for (const step of steps) {
    const surface = surfaces.get(step.item.id);
    if (!surface) continue;
    const iconRef = surface.icon ? icons.ref(surface.icon) : undefined;
    step.surface = iconRef ? { ...surface, iconRef } : surface;
  }
  return {
    type: "turn.steps",
    requestId: message.requestId,
    threadId: message.threadId,
    turnOrdinal: message.turnOrdinal,
    seq,
    endSeq: turn.endSeq,
    steps,
    after: matching.length > page.length ? (steps.at(-1)?.seq ?? null) : null,
  };
}
