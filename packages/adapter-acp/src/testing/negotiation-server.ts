// Synthetic ACP v1 server. No provider code, credentials, login or network calls.
import { createInterface } from "node:readline";
import { z } from "zod";
const config = z
  .object({
    http: z.boolean().default(false),
    load: z.boolean().default(false),
    legacy: z.boolean().default(false),
    noSelectors: z.boolean().default(false),
    flood: z.boolean().default(false),
    failInitialize: z.boolean().default(false),
    failSession: z.boolean().default(false),
    subagents: z.boolean().default(false),
    airSubagents: z.boolean().default(false),
  })
  .parse(JSON.parse(process.env.ACE_SYNTHETIC_ACP ?? "{}"));
const Envelope = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let selectorValues = ["model-a", "model-b"];
const setup = () =>
  config.noSelectors
    ? {}
    : config.legacy
      ? {
          models: {
            availableModels: [{ modelId: "model-a", name: "Model A" }],
            currentModelId: "model-a",
          },
          modes: { availableModes: [{ id: "plan", name: "Plan" }] },
        }
      : {
          configOptions: [
            {
              id: "provider-model-id",
              category: "model",
              type: "select",
              currentValue: "model-a",
              options: selectorValues.map((value) => ({ value, name: value })),
            },
          ],
          modes: { availableModes: [{ id: "plan", name: "Plan" }] },
        };
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = Envelope.parse(JSON.parse(line));
  const result = (value: unknown) => write({ id: message.id, result: value });
  if (
    (message.method === "initialize" && config.failInitialize) ||
    (message.method === "session/new" && config.failSession)
  ) {
    write({ id: message.id, error: { code: -1, message: "Synthetic startup failure" } });
    return;
  }
  if (message.method === "initialize")
    result({
      protocolVersion: 1,
      ...(config.airSubagents
        ? {
            _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } },
          }
        : {}),
      agentCapabilities: {
        loadSession: config.load,
        sessionCapabilities: config.subagents ? { subagents: {} } : {},
        mcpCapabilities: { http: config.http },
        promptCapabilities: { image: true },
        futureExtension: { preserved: true },
      },
      authMethods: [{ id: "not-login-status", name: "CLI-owned login" }],
      future: "kept",
    });
  else if (message.method === "session/new" || message.method === "session/load") {
    result({
      ...(message.method === "session/new" ? { sessionId: "synthetic-session" } : {}),
      ...setup(),
      echo: message.params,
    });
    if (config.flood)
      for (let id = 100; id < 240; id++)
        write({
          id,
          method: "session/request_permission",
          params: {
            sessionId: "synthetic-session",
            toolCall: { toolCallId: String(id), title: "Approve" },
            options: [{ optionId: "yes", kind: "allow_once", name: "Yes" }],
          },
        });
  } else if (message.method === "session/set_config_option") {
    if (message.params.configId !== "provider-model-id")
      write({ id: message.id, error: { code: -1, message: "Wrong config ID" } });
    else {
      selectorValues = ["model-b"];
      result(setup());
    }
  } else if (message.method === "session/set_model" || message.method === "session/set_mode")
    result({});
  else if (message.method === "session/prompt") {
    write({
      method: "session/update",
      params: {
        sessionId: "synthetic-session",
        update: { sessionUpdate: "future_update", futureField: { retained: true } },
      },
    });
    write({ id: 900, method: "vendor/unknown", params: { future: "kept" } });
    result({ stopReason: "end_turn" });
  } else if (message.method)
    write({ id: message.id, error: { code: -32601, message: "Unsupported synthetic method" } });
});
process.once("SIGTERM", () => {
  write({
    method: "session/update",
    params: {
      sessionId: "synthetic-session",
      update: { sessionUpdate: "future_shutdown", final: true },
    },
  });
  process.exitCode = 0;
  process.stdin.destroy();
});
