import { randomBytes } from "node:crypto";
import type { Interface } from "node:readline";
import { probe, spawnSupervised } from "@ace/provider-kit/process";
import { readSse } from "@ace/provider-kit/sse";
import { interruptOnce } from "../interrupt.ts";
import type { Recording } from "../recording.ts";
import type { Driver, RunContext } from "./types.ts";

type Params = Record<string, unknown>;

function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) throw new Error(`OpenCode model must be provider/model, got ${model}`);
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** Minimal HTTP client that records every request and response. */
function createClient(base: string, auth: string, directory: string, rec: Recording) {
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = new URL(path, base);
    url.searchParams.set("directory", directory);
    rec.frame("send", "http", { method, path, body });
    const res = await fetch(url, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    rec.frame("recv", "http", { method, path, status: res.status, body: parsed });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return parsed;
  };
}

/** Keep draining stdout (so the server never blocks) and resolve with its listen URL. */
function waitForListenUrl(stdout: Interface, rec: Recording, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("opencode serve did not listen")), timeoutMs);
    const lines = stdout;
    lines.on("line", (line) => {
      rec.frame("recv", "stdout", line, false);
      const match = /listening on (http:\/\/\S+)/.exec(line);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    lines.on("close", () => {
      clearTimeout(timeout);
      reject(new Error("opencode serve exited before listening"));
    });
  });
}

export const opencode: Driver = {
  id: "opencode",
  version: () => probe("opencode", ["--version"]),
  async run(ctx: RunContext) {
    const { rec, scenario, workspace } = ctx;
    const password = randomBytes(18).toString("base64url");
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const proc = spawnSupervised({
      command: "opencode",
      args: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      name: "recorder-opencode",
      cwd: workspace,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "ask", bash: "ask" } }),
        ...(scenario.id === "subagent-background"
          ? { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "1" }
          : {}),
        ...(scenario.planMode ? { OPENCODE_EXPERIMENTAL_PLAN_MODE: "1" } : {}),
      },
    });
    proc.stderr.on("line", (line) => rec.frame("stderr", "stdio", line, false));
    const sse = new AbortController();
    const sessions: string[] = [];

    try {
      const base = await waitForListenUrl(proc.stdout, rec, 30_000);
      const http = createClient(base, auth, workspace, rec);

      let rootId = "";
      let rootBusy = false;
      /** Tool name per call id, so questions can be traced to the tool that asked. */
      const toolByCall = new Map<string, string>();
      const triggerInterrupt = interruptOnce(scenario.interruptAfterToolStartMs, () => {
        rec.note("interrupt-sent");
        void http("POST", `/session/${rootId}/abort`);
      });

      const handle = async (event: Params): Promise<void> => {
        const payload = (event["payload"] ?? {}) as Params;
        const type = payload["type"];
        const props = (payload["properties"] ?? {}) as Params;
        if (type === "session.status") {
          const status = props["status"] as Params | string | undefined;
          const kind = typeof status === "string" ? status : status?.["type"];
          if (props["sessionID"] === rootId) {
            if (kind === "busy") rootBusy = true;
            if (kind === "idle" && rootBusy) {
              rootBusy = false;
              rec.mark("turn-end");
            }
          } else if (kind === "idle") {
            rec.mark("child-turn-end", { sessionID: props["sessionID"] });
          }
        }
        if (type === "session.created") {
          const info = (props["info"] ?? {}) as Params;
          if (typeof info["id"] === "string") sessions.push(info["id"]);
        }
        if (type === "message.part.updated") {
          const part = (props["part"] ?? {}) as Params;
          const state = (part["state"] ?? {}) as Params;
          if (part["type"] === "tool" && typeof part["callID"] === "string") {
            toolByCall.set(part["callID"], String(part["tool"]));
          }
          if (
            part["sessionID"] === rootId &&
            part["type"] === "tool" &&
            part["tool"] === "bash" &&
            state["status"] === "running"
          ) {
            triggerInterrupt();
          }
        }
        if (type === "permission.asked") {
          ctx.interactions.open();
          try {
            await http("POST", `/permission/${String(props["id"])}/reply`, { reply: "once" });
          } finally {
            ctx.interactions.close();
          }
        }
        if (type === "question.asked") {
          ctx.interactions.open();
          try {
            const id = String(props["id"]);
            const callID = ((props["tool"] ?? {}) as Params)["callID"];
            const askedBy = typeof callID === "string" ? toolByCall.get(callID) : undefined;
            if (askedBy === "plan_exit" && scenario.planDecision === "reject") {
              await http("POST", `/question/${id}/reject`);
            } else {
              const questions = (props["questions"] ?? []) as Array<{
                options?: Array<{ label: string }>;
              }>;
              await http("POST", `/question/${id}/reply`, {
                answers: questions.map((q) => [q.options?.[0]?.label ?? "Tabs"]),
              });
            }
          } finally {
            ctx.interactions.close();
          }
        }
      };

      void readSse(new URL("/global/event", base), {
        signal: sse.signal,
        headers: { authorization: auth },
        reconnect: false,
        onEvent: ({ data: text }) => {
          const data: unknown = JSON.parse(text);
          const event = (data ?? {}) as Params;
          const type = ((event["payload"] ?? {}) as Params)["type"];
          rec.frame(
            "recv",
            "sse",
            data,
            type !== "server.heartbeat" && type !== "server.connected",
          );
          handle(event).catch((error: unknown) => rec.note("handler-error", String(error)));
        },
      }).catch((error: unknown) => rec.note("sse-error", String(error)));

      const session = (await http("POST", "/session", { title: "ace-recorder" })) as { id: string };
      rootId = session.id;
      sessions.push(rootId);
      await http("POST", `/session/${rootId}/prompt_async`, {
        parts: [{ type: "text", text: scenario.prompt }],
        ...(ctx.model ? { model: splitModel(ctx.model) } : {}),
        ...(scenario.planMode ? { agent: "plan" } : {}),
      });
      await Promise.race([ctx.settled(), proc.exited]);

      // Keep the user's OpenCode history clean: delete what we created.
      for (const id of new Set(sessions)) {
        await http("DELETE", `/session/${id}`).catch(() => {});
      }
    } finally {
      sse.abort();
      await proc.stop();
    }
  },
};
