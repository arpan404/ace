import { JsonRpcPeer, type ServerRequest } from "../jsonrpc.ts";
import { interruptOnce, probe, spawnOwned } from "../process.ts";
import type { Driver, RunContext } from "./types.ts";

type Params = Record<string, unknown>;

/** Scripted human: approve everything once, answer questions with the first option. */
function respond(request: ServerRequest): unknown {
  const params = (request.params ?? {}) as Params;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    case "item/permissions/requestApproval":
      return { permissions: params["permissions"] ?? {}, scope: "turn" };
    case "item/tool/requestUserInput": {
      const questions = (params["questions"] ?? []) as Array<{
        id: string;
        options: Array<{ label: string }> | null;
      }>;
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of questions) answers[q.id] = { answers: [q.options?.[0]?.label ?? "Tabs"] };
      return { answers };
    }
    case "mcpServer/elicitation/request":
      return { action: "decline" };
    default:
      throw new Error(`recorder has no scripted answer for ${request.method}`);
  }
}

export const codex: Driver = {
  id: "codex",
  async version() {
    const out = await probe("codex", ["--version"]);
    return out.replace(/^codex-cli\s+/, "");
  },
  async run(ctx: RunContext) {
    const { rec, scenario, workspace } = ctx;
    const proc = spawnOwned("codex", ["app-server"], { cwd: workspace });
    const rpc = new JsonRpcPeer(proc.child, rec);

    let rootThreadId = "";
    let rootTurnId = "";
    const triggerInterrupt = interruptOnce(scenario.interruptAfterToolStartMs, () => {
      rec.note("interrupt-sent");
      void rpc.request("turn/interrupt", { threadId: rootThreadId, turnId: rootTurnId });
    });

    rpc.onNotification = ({ method, params }) => {
      const p = (params ?? {}) as Params;
      const threadId = p["threadId"];
      if (method === "turn/started" && threadId === rootThreadId) {
        rootTurnId = String((p["turn"] as Params | undefined)?.["id"] ?? "");
      }
      if (method === "turn/completed") {
        rec.mark(threadId === rootThreadId ? "turn-end" : "child-turn-end", { threadId });
      }
      if (method === "item/started") {
        const item = p["item"] as Params | undefined;
        if (item?.["type"] === "commandExecution" && threadId === rootThreadId) triggerInterrupt();
      }
      // Async questions arrive as an agent message, not a server request. The
      // answer goes back as steering input on the running turn.
      if (method === "item/completed") {
        const item = (p["item"] ?? {}) as Params;
        const questions = item["questions"] as Array<{ options?: string[] }> | undefined;
        if (item["delivery"] === "async" && questions?.length && threadId === rootThreadId) {
          const answer = questions.map((q) => q.options?.[0] ?? "Tabs").join("; ");
          rec.note("async-question-answered", { answer });
          void rpc.request("turn/steer", {
            threadId: rootThreadId,
            expectedTurnId: rootTurnId,
            input: [{ type: "text", text: answer, text_elements: [] }],
          });
        }
      }
    };
    rpc.onRequest = async (request) => {
      ctx.interactions.open();
      try {
        return respond(request);
      } finally {
        ctx.interactions.close();
      }
    };

    try {
      await rpc.request("initialize", {
        clientInfo: { name: "ace_recorder", title: "ace recorder", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify("initialized");
      const started = (await rpc.request("thread/start", {
        cwd: workspace,
        ...(ctx.model ? { model: ctx.model } : {}),
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      })) as { thread: { id: string }; model: string };
      rootThreadId = started.thread.id;

      await rpc.request("turn/start", {
        threadId: rootThreadId,
        input: [{ type: "text", text: scenario.prompt, text_elements: [] }],
        ...(scenario.planMode
          ? {
              collaborationMode: {
                mode: "plan",
                settings: {
                  model: started.model,
                  reasoning_effort: null,
                  developer_instructions: null,
                },
              },
            }
          : {}),
      });
      await Promise.race([ctx.settled(), proc.exited]);
    } finally {
      await proc.stop();
    }
  },
};
