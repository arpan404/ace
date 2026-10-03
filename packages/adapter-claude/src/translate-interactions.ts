import { InteractionRequest, InteractionResolution } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { ClaudeState } from "./state.ts";
import { requestFor, resolutionFor } from "./interactions.ts";
import { object, string, type Data } from "./native.ts";
import { tool } from "./content.ts";
import { canonicalOnly } from "./raw-facts.ts";
function resolutionForElicitation(
  data: Data,
): Extract<InteractionResolution, { kind: "elicitation" }> {
  const answer = InteractionResolution.safeParse(data["resolution"]);
  return answer.success && answer.data.kind === "elicitation"
    ? answer.data
    : { kind: "elicitation", action: "cancel" };
}

function permission(state: ClaudeState, data: Data, frame: Frame): void {
  if (frame.dir === "send") {
    const id = string(data["requestId"]);
    const interaction = state.interactions.get(id);
    if (!interaction) return;
    state.toolFrames.set(interaction.toolId, frame.seq);
    const result = object(data["result"]);
    const denied = result["behavior"] === "deny";
    // A late reply cannot replace a tool's settled outcome or reopen its work.
    if (!state.terminalChildren.has(interaction.agent))
      state.emit({
        type: "item.upsert",
        agent: interaction.agent,
        item: interaction.item,
        draft: {
          type: "tool_call",
          complete: denied,
          call: {
            status: denied ? (result["interrupt"] === true ? "cancelled" : "declined") : "running",
          },
        },
      });
    state.emit({
      type: "interaction.closed",
      interaction: state.key("interaction", id),
      state: "resolved",
      resolution: resolutionFor(interaction.request, data["result"], data["resolution"]),
    });
    state.interactions.delete(id);
    return;
  }
  const options = object(data["options"]);
  const id = string(options["requestId"]);
  if (!id) return;
  const native = string(options["agentID"]);
  const task = state.tasks.get(native);
  const agent = native
    ? (state.nativeAgents.get(native) ??
      state.child(`native:${native}`, state.root, false, native, task?.terminalStatus))
    : state.root;
  if (task?.terminal) {
    task.child = agent;
    state.endChild(task, task.terminalStatus ?? "failed");
  }
  const toolId = string(options["toolUseID"], `interaction:${id}`);
  const name = string(data["toolName"], "Unknown tool");
  state.toolFrames.set(toolId, frame.seq);
  const start = state.facts.length;
  tool(state, agent, { id: toolId, name, input: data["input"] }, data, true);
  if (state.terminalChildren.has(agent)) {
    state.interactions.delete(id);
    // Retire stale permissions without opening human work. Keep their raw once.
    for (let index = start; index < state.facts.length; index++) {
      const fact = state.facts[index];
      if (fact) state.facts[index] = canonicalOnly(fact);
    }
    state.notice(
      data,
      `settled-permission:${frame.seq}`,
      agent,
      "info",
      "Claude permission retired for a settled child",
    );
    return;
  }
  const request = requestFor(name, object(data["input"]), options);
  state.interactions.set(id, { agent, item: state.key("tool", toolId), toolId, request });
  state.emit({
    type: "interaction.opened",
    agent,
    interaction: state.key("interaction", id),
    item: state.key("tool", toolId),
    blocking: true,
    request,
    raw: [{ type: "can_use_tool", name, data }],
  });
}

export function interactionFrame(state: ClaudeState, frame: Frame, data: Data): boolean {
  if (frame.channel === "elicitation") {
    const id = string(data["requestId"]);
    const interaction = state.key("interaction", id);
    if (frame.dir === "recv") {
      const request = InteractionRequest.safeParse(data["request"]);
      if (id && request.success && request.data.kind === "elicitation") {
        state.interactions.set(id, {
          agent: state.root,
          item: interaction,
          toolId: "",
          request: request.data,
        });
        state.emit({
          type: "interaction.opened",
          agent: state.root,
          interaction,
          blocking: true,
          request: request.data,
          raw: [{ type: "elicitation", data: frame.data }],
        });
      }
    } else if (state.interactions.delete(id)) {
      state.emit({
        type: "interaction.closed",
        interaction,
        state: "resolved",
        resolution: resolutionForElicitation(data),
      });
    }
  } else if (frame.channel === "interaction_lifecycle") {
    const id = string(data["requestId"]);
    if (state.interactions.delete(id))
      state.emit({
        type: "interaction.closed",
        interaction: state.key("interaction", id),
        state: data["state"] === "expired" ? "expired" : "cancelled",
      });
  } else if (frame.channel === "can_use_tool") permission(state, data, frame);
  else return false;
  return true;
}
