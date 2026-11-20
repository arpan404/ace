import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { AcpConfiguration } from "./configuration.ts";
import { genericQuirks } from "./index.ts";

/*
 * What a selection may send and what its reply means (ADR 0044, unprofiled agents choose
 * models): only ids the agent listed go back to it, and a reply naming another current value
 * never counts as applied. The agent is a scripted JSON-RPC peer at the boundary.
 */

/** A configuration over a peer that answers every request with `reply`, recording requests. */
function configured(reply: unknown, secrets: readonly string[] = []) {
  const sent: { method: string; params: unknown }[] = [];
  const context: SessionContext = {
    threadId: ThreadId.parse("thread-config"),
    cwd: "/",
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
    mcp: { httpServers: [], secrets, end() {} },
  };
  const configuration = new AcpConfiguration(
    context,
    genericQuirks,
    { command: "/bin/agent", args: [] },
    {
      request: async (method, params) => {
        sent.push({ method, params });
        return reply;
      },
    },
  );
  configuration.initialize({ protocolVersion: 1 });
  return { configuration, sent };
}

const legacyModels = {
  models: {
    availableModels: [{ modelId: "model-a" }, { modelId: "model-b" }],
    currentModelId: "model-a",
  },
};

test("a reply that empties its options but names another current model didn't apply the selection", async () => {
  const { configuration } = configured({
    configOptions: [],
    models: { currentModelId: "model-a" },
  });
  configuration.setup(legacyModels, "unavailable");
  await expect(configuration.select("model", "model-b", "s")).rejects.toThrow(
    "ACP model model-b was not applied; the agent runs model-a",
  );
});

test("a reply whose model option names another value didn't apply the selection, whatever it replaces", async () => {
  const { configuration } = configured({
    configOptions: [{ id: "model", category: "model", type: "select", currentValue: "model-a" }],
  });
  configuration.setup(
    {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "model-a",
          options: [{ value: "model-a" }, { value: "model-b" }],
        },
      ],
    },
    "unavailable",
  );
  await expect(configuration.select("model", "model-b", "s")).rejects.toThrow("not applied");
});

test("a reply naming the requested model applies it", async () => {
  const { configuration } = configured({
    configOptions: [],
    models: { currentModelId: "model-b" },
  });
  configuration.setup(legacyModels, "unavailable");
  await expect(configuration.select("model", "model-b", "s")).resolves.toBeUndefined();
});

test("a model id lease redaction changed is never sent, though the setup still shows it redacted", async () => {
  const secret = "lease-secret-1234";
  const { configuration, sent } = configured({}, [secret]);
  configuration.setup(
    {
      models: {
        availableModels: [{ modelId: `model-${secret}` }, { modelId: "model-b" }],
        currentModelId: "model-b",
      },
    },
    "unavailable",
  );
  expect(JSON.stringify(configuration.selectors.raw)).toContain("model-[ace lease redacted]");
  expect(JSON.stringify(configuration.selectors.raw)).not.toContain(secret);
  await expect(configuration.select("model", "model-[ace lease redacted]", "s")).rejects.toThrow(
    "selection unavailable",
  );
  await expect(configuration.select("model", `model-${secret}`, "s")).rejects.toThrow(
    "selection unavailable",
  );
  expect(sent).toEqual([]);
  await configuration.select("model", "model-b", "s");
  expect(sent).toEqual([
    { method: "session/set_model", params: { sessionId: "s", modelId: "model-b" } },
  ]);
});
