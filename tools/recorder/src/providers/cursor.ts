import { MethodNotFound, type ServerRequest } from "@ace/provider-kit/jsonrpc";
import { probe, spawnSupervised } from "@ace/provider-kit/process";
import { createRecordedPeer } from "../stdio.ts";
import { interruptOnce } from "../interrupt.ts";
import type { Scenario } from "../scenarios.ts";
import type { Driver, RunContext } from "./types.ts";

type Params = Record<string, unknown>;

function respond(request: ServerRequest, scenario: Scenario): unknown {
  const params = (request.params ?? {}) as Params;
  switch (request.method) {
    case "session/request_permission": {
      const options = (params["options"] ?? []) as Array<{ optionId: string; kind: string }>;
      const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    case "cursor/ask_question": {
      const questions = (params["questions"] ?? []) as Array<{
        id: string;
        options: Array<{ id: string }>;
      }>;
      return {
        outcome: {
          outcome: "answered",
          answers: questions.map((q) => ({
            questionId: q.id,
            selectedOptionIds: q.options[0] ? [q.options[0].id] : [],
          })),
        },
      };
    }
    case "cursor/create_plan":
      return scenario.planDecision === "approve"
        ? { outcome: { outcome: "accepted" } }
        : { outcome: { outcome: "rejected", reason: "Plan recorded. Do not implement it." } };
    case "cursor/update_todos":
    case "cursor/task":
    case "cursor/generate_image":
      return {};
    default:
      throw new MethodNotFound(`recorder has no scripted answer for ${request.method}`);
  }
}

export const cursor: Driver = {
  id: "cursor",
  version: () => probe("agent", ["--version"]),
  async run(ctx: RunContext) {
    const { rec, scenario, workspace } = ctx;
    const proc = spawnSupervised({
      command: "agent",
      args: ["acp"],
      cwd: workspace,
      env: {},
      name: "recorder-cursor",
    });
    const rpc = createRecordedPeer(proc, rec);

    let sessionId = "";
    const triggerInterrupt = interruptOnce(scenario.interruptAfterToolStartMs, () => {
      rec.note("interrupt-sent");
      rpc.notify("session/cancel", { sessionId });
    });

    rpc.onNotification = ({ method, params }) => {
      if (method !== "session/update") return;
      const p = (params ?? {}) as Params;
      const update = (p["update"] ?? {}) as Params;
      if (p["sessionId"] === sessionId && update["sessionUpdate"] === "tool_call") {
        if (update["kind"] === "execute") triggerInterrupt();
      }
    };
    rpc.onRequest = async (request) => {
      ctx.interactions.open();
      try {
        return respond(request, scenario);
      } finally {
        ctx.interactions.close();
      }
    };

    try {
      await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { subagents: {}, parameterizedModelPicker: true },
        },
        clientInfo: { name: "ace-recorder", version: "0.0.0" },
      });
      const session = (await rpc.request("session/new", { cwd: workspace, mcpServers: [] })) as {
        sessionId: string;
      };
      sessionId = session.sessionId;
      if (scenario.planMode) {
        await rpc.request("session/set_mode", { sessionId, modeId: "plan" });
      }
      rpc
        .request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: scenario.prompt }],
        })
        .then(
          (result) => rec.mark("turn-end", result),
          (error: unknown) => rec.mark("turn-end", { error: String(error) }),
        );
      await Promise.race([ctx.settled(), proc.exited]);
    } finally {
      await proc.stop();
    }
  },
};
