// Local protocol boundary only. Never starts a provider or a model.
// Writes the frames of one scenario in ONE stdout chunk, so frame order inside a read is fixed.
import { createInterface } from "node:readline";
import { z } from "zod";
import { list, object, string } from "../data.ts";
const config = z
  .object({
    name: z.string().default("frame-order"),
    resumeOnly: z.boolean().default(false),
    hangOpen: z.boolean().default(false),
  })
  .parse(JSON.parse(process.env.ACE_FRAME_ORDER ?? "{}"));
const root = "fo-root";
const line = (value: unknown) => JSON.stringify(value);
const chunk = (...frames: unknown[]) => process.stdout.write(frames.map(line).join("\n") + "\n");
const update = (value: unknown, sessionId = root) => ({
  method: "session/update",
  params: { sessionId, update: value },
});
const options = { model: "model-a" };
const configUpdate = () =>
  update({
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: options.model,
        options: [
          { value: "model-a", name: "A" },
          { value: "model-b", name: "B" },
        ],
      },
    ],
  });
const later = (ms: number, ...frames: unknown[]) => setTimeout(() => chunk(...frames), ms);
/** Prompt ids waiting on an answer to a request: request id → prompt id. */
const waiting = new Map<unknown, unknown>();
createInterface({ input: process.stdin }).on("line", (text) => {
  const frame = object(JSON.parse(text));
  const id = frame["id"];
  const params = object(frame["params"]);
  const method = frame["method"];
  if (method === undefined && waiting.has(id)) {
    chunk({ id: waiting.get(id), result: { stopReason: "end_turn" } });
    waiting.delete(id);
    return;
  }
  if (method === "initialize")
    chunk({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: config.name },
        agentCapabilities: config.resumeOnly
          ? { sessionCapabilities: { resume: {} } }
          : { loadSession: true },
      },
    });
  else if (method === "session/new") {
    if (config.hangOpen) return;
    // The agent reports its options before it answers; the answer names none.
    chunk(configUpdate(), { id, result: { sessionId: root } });
  } else if (method === "session/resume") chunk({ id, result: {} });
  else if (method === "session/load") {
    chunk(
      // History: a shell from an earlier process.
      update({
        sessionUpdate: "tool_call",
        toolCallId: "old",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 60" },
      }),
      configUpdate(),
      { id, result: {} },
      // Live, right after the reply in the same read.
      update({
        sessionUpdate: "tool_call",
        toolCallId: "live",
        kind: "read",
        status: "in_progress",
      }),
    );
    later(
      150,
      update({ sessionUpdate: "tool_call_update", toolCallId: "live", status: "completed" }),
    );
  } else if (method === "session/prompt") {
    const prompt = string(object(list(params["prompt"])[0])["text"]);
    const end = (stopReason: string) => ({ id, result: { stopReason } });
    if (prompt === "error-approval")
      chunk(
        {
          id: 200,
          method: "session/request_permission",
          params: {
            sessionId: root,
            toolCall: { toolCallId: "ea", title: "Write" },
            options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
          },
        },
        { id, error: { code: -32603, message: "Internal error" } },
      );
    else if (prompt === "approval-first") {
      waiting.set(201, id);
      chunk({
        id: 201,
        method: "session/request_permission",
        params: {
          sessionId: root,
          toolCall: {
            toolCallId: "af",
            kind: "execute",
            title: "Run",
            rawInput: { command: "sleep 60" },
          },
          options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
        },
      });
    } else if (prompt === "post-reply") {
      chunk(
        end("end_turn"),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "pr",
          kind: "read",
          status: "in_progress",
        }),
      );
      later(
        150,
        update({ sessionUpdate: "tool_call_update", toolCallId: "pr", status: "completed" }),
      );
    } else if (prompt === "child-resurrect")
      chunk(
        update({ sessionUpdate: "subagent_spawned", subagentSessionId: "kid" }),
        update({
          sessionUpdate: "subagent_state_update",
          subagentSessionId: "kid",
          state: "completed",
        }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "kt", status: "completed" }, "kid"),
        end("end_turn"),
      );
    else if (prompt === "child-silent")
      chunk(
        update({
          sessionUpdate: "subagent_spawned",
          subagentSessionId: "quiet",
          capabilities: { cancel: {} },
        }),
        end("end_turn"),
      );
    else if (prompt === "cancel-shell")
      chunk(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "sh",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "sleep 60" },
        }),
        end("cancelled"),
      );
    else if (prompt === "hang") return;
    else chunk(end("end_turn"));
  }
  // session/cancel and answers to other requests: the agent says nothing.
});
