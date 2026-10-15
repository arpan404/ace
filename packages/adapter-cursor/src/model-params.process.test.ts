import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogModel } from "@ace/protocol";
import { cursorModelParams } from "@ace/provider-kit/cursor-selection";
import { expect, it } from "vitest";
import { HostRuntime, CursorLimitsSchema, type RuntimeSdkBoundary } from "./index.ts";

/** Grok 4.7 as `Cursor.models.list()` reports it: every context × effort × fast variant,
 * with the 500k High Fast variant marked default. */
const efforts = ["low", "medium", "high", "xhigh"];
const variants = ["256k", "500k"].flatMap((context) =>
  efforts.flatMap((effort) =>
    ["false", "true"].map((fast) => ({ context, reasoning_effort: effort, fast })),
  ),
);
const grok = CatalogModel.parse({
  id: "grok-4.7",
  displayName: "Grok 4.7",
  provider: "cursor",
  instance: "cursor-sdk-default",
  nativeModelId: "grok-4.7",
  efforts: efforts.map((effort) => ({ id: effort, level: effort, label: effort })),
  defaultEffort: "high",
  serviceTiers: variants.map((parameters, index) => ({
    id: String(index),
    name: "Grok 4.7",
    ...(parameters.fast === "true" ? { speed: "fast" } : {}),
    parameters: { ...parameters, ...(parameters.fast === "true" ? { serviceTier: "fast" } : {}) },
  })),
  defaultTier: String(
    variants.findIndex((v) => v.context === "500k" && v.reasoning_effort === "high" && v.fast),
  ),
  inputModalities: [],
  isDefault: false,
  hidden: false,
  deprecated: false,
  raw: { json: "{}", truncated: false },
});

it("sends Grok 4.7 turns at the standard 256k context the local runtime accepts", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-model-params-")));
  const created: unknown[] = [];
  const sent: unknown[] = [];
  const boundary: RuntimeSdkBoundary = {
    ...sdk,
    Cursor: {
      auth: {
        async status() {
          return { status: "logged-in", backendUrl: "https://synthetic.invalid" };
        },
      },
    },
    Agent: {
      async create(options) {
        created.push(options.model);
        return {
          agentId: "grok-agent",
          async send(_input, sendOptions) {
            sent.push(sendOptions?.model);
            return {
              id: "run-1",
              async *stream() {},
              async wait() {
                return { id: "run-1", status: "finished" };
              },
              async cancel() {},
            };
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      async resume() {
        throw new Error("Expected a new agent");
      },
      async cancelRun() {},
    },
  };
  const finished = Promise.withResolvers<void>();
  const host = new HostRuntime(
    boundary,
    async (frame) => {
      if (frame.kind === "result" && frame.runId === "run-1") finished.resolve();
    },
    () => home,
    {},
  );
  try {
    await host.open({
      threadId: "grok",
      generation: "one",
      cwd: home,
      model: "grok-4.7",
      modelParams: cursorModelParams(grok, { effort: "high", serviceTier: "fast" }),
      policy: "full-access",
      limits: CursorLimitsSchema.parse({}),
    });
    await host.send({ operationId: "first", segment: 0, input: [{ type: "text", text: "hi" }] });
    await finished.promise;
    await host.configure({
      model: "grok-4.7",
      modelParams: cursorModelParams(grok, { effort: "xhigh", serviceTier: "default" }),
    });
    await host.send({ operationId: "second", segment: 0, input: [{ type: "text", text: "hi" }] });
    const highFast = {
      id: "grok-4.7",
      params: [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    };
    expect(created).toEqual([highFast]);
    expect(sent).toEqual([
      highFast,
      {
        id: "grok-4.7",
        params: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "xhigh" },
          { id: "fast", value: "false" },
        ],
      },
    ]);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
