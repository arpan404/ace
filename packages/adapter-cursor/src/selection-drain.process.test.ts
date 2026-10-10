import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostRuntime, CursorLimitsSchema, type RuntimeSdkBoundary } from "./index.ts";

it("drains terminal acknowledgements before configuring the next turn on the same native agent", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-selection-drain-")));
  const terminal = Promise.withResolvers<void>(),
    ack = Promise.withResolvers<void>();
  const sentModels: unknown[] = [];
  let run = 0;
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
      async create() {
        return {
          agentId: "one-agent",
          async send(_input, options) {
            sentModels.push(options?.model);
            const id = `run-${++run}`;
            return {
              id,
              async *stream() {},
              async wait() {
                return { id, status: "finished" };
              },
              async cancel() {},
            };
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      async resume() {
        throw new Error("Must preserve the original agent");
      },
      async cancelRun() {},
    },
  };
  const host = new HostRuntime(
    boundary,
    async (frame) => {
      if (frame.kind === "result" && frame.runId === "run-1") {
        terminal.resolve();
        await ack.promise;
      }
    },
    () => home,
    {},
  );
  try {
    await host.open({
      threadId: "selection",
      generation: "one",
      cwd: home,
      model: "native-a",
      modelParams: [{ id: "effort", value: "high" }],
      policy: "full-access",
      limits: CursorLimitsSchema.parse({}),
    });
    await host.send({ operationId: "first", segment: 0, input: [{ type: "text", text: "first" }] });
    await terminal.promise;
    const changed = host.configure({
      model: "native-b",
      modelParams: [
        { id: "reasoning", value: "low" },
        { id: "fast", value: "true" },
      ],
    });
    // ACK remains withheld while the daemon already considers the terminal result committed.
    ack.resolve();
    await changed;
    await host.send({
      operationId: "second",
      segment: 0,
      input: [{ type: "text", text: "second" }],
    });
    await host.close();
    expect(sentModels).toEqual([
      { id: "native-a", params: [{ id: "effort", value: "high" }] },
      {
        id: "native-b",
        params: [
          { id: "reasoning", value: "low" },
          { id: "fast", value: "true" },
        ],
      },
    ]);
  } finally {
    ack.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
