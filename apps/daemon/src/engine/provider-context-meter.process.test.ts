import { expect, test, onTestFinished } from "vitest";
import { privateMcpConfig } from "@ace/mcp-server";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import {
  createPiTranslator,
  piCapabilities,
  registerAcePiExtension,
  type PiExtensionApi,
} from "@ace/adapter-pi";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame } from "@ace/engine-api";
import { harness, scriptFrames } from "./test-support.ts";

test.each(["pi", "cursor"] as const)(
  "%s context samples replace occupancy and ignore cumulative run billing",
  async (provider) => {
    let seq = 0;
    const frame = (data: unknown): Frame => {
      const payload = new ProviderPayload(JSON.stringify(data));
      return {
        seq: ++seq,
        t: seq,
        dir: "recv",
        channel: provider === "cursor" ? "sdk" : "stdio",
        data: payload.data,
        payload,
      };
    };
    const hooks = new Map<string, unknown[]>();
    const extension: PiExtensionApi = {
      appendEntry() {},
      registerCommand() {},
      registerTool() {},
      on(event, handler) {
        hooks.set(event, [...(hooks.get(event) ?? []), handler]);
      },
    };
    if (provider === "pi") {
      const config = privateMcpConfig(JSON.stringify({ controlSecret: "a".repeat(64) }));
      onTestFinished(config.remove);
      await registerAcePiExtension(extension, { ACE_PI_SESSION_FILE: config.path });
    }
    const cursor = (kind: string, body: unknown) =>
      frame({ schemaVersion: 1, generation: "host", operationId: "op", segment: 0, kind, body });
    const pi = (tokens: number) => {
      let message = "";
      const handlers = hooks.get("turn_end") ?? [];
      if (!handlers.length) throw new Error("Pi extension did not report context usage");
      for (const hook of handlers) {
        if (typeof hook !== "function") throw new Error("Invalid Pi event handler");
        Reflect.apply(hook, undefined, [
          {},
          {
            getContextUsage: () => ({ tokens, contextWindow: 128000 }),
            model: { provider: "local", id: "model" },
            ui: {
              notify(value: string) {
                message = value;
              },
            },
          },
        ]);
      }
      return frame({
        type: "extension_ui_request",
        id: `context-${seq}`,
        method: "notify",
        message,
      });
    };
    const initial =
      provider === "cursor"
        ? [
            cursor("open", { cwd: "/synthetic", model: "model" }),
            cursor("send", { input: [] }),
            cursor("delta", {
              type: "turn-ended",
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                cacheReadTokens: 40,
                cacheWriteTokens: 10,
                reasoningTokens: 7,
              },
            }),
            cursor("result", {
              status: "finished",
              usage: { inputTokens: 900000, outputTokens: 9000 },
            }),
          ]
        : [frame({ type: "agent_start" }), pi(170), frame({ type: "agent_settled" })];
    const adapter = createScriptedAdapter({
      provider,
      nativeSessionId: "native",
      capabilities:
        provider === "cursor"
          ? cursorCapabilities
          : piCapabilities({
              installed: true,
              version: "0.85.1",
              auth: "unknown",
              loginHint: "unused",
            }),
      createTranslator: (init) =>
        provider === "cursor" ? new CursorTranslator(init) : createPiTranslator(init),
      steps: [{ on: "send", frames: initial }],
    });
    const h = await harness([], scriptFrames(), { provider, nativeAdapter: adapter });
    try {
      const id = await h.create();
      const root = h.store.getThread(id)?.rootAgentId;
      if (!root) throw new Error("Missing root");
      const meter = () => h.store.snapshotThread(id).contextMeters?.[root];
      expect(meter()).toMatchObject({
        usedTokens: 170,
        windowTokens: provider === "pi" ? 128000 : null,
      });
      const next =
        provider === "cursor"
          ? cursor("delta", { type: "turn-ended", usage: { inputTokens: 30, outputTokens: 5 } })
          : pi(35);
      h.contexts[0]?.onFrame(next);
      await h.engine.flush();
      expect(meter()?.usedTokens).toBe(35);
      if (provider === "cursor")
        h.contexts[0]?.onFrame(
          cursor("result", {
            status: "finished",
            usage: { inputTokens: 1000000, outputTokens: 200000 },
          }),
        );
      else
        h.contexts[0]?.onFrame(
          frame({
            type: "message_end",
            message: { role: "assistant", content: [], usage: { input: 1000000, output: 200000 } },
          }),
        );
      await h.engine.flush();
      expect(meter()?.usedTokens).toBe(35);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  },
);
