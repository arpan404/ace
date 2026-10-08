import { z } from "zod";
import { ScreenId, type ApprovalTarget } from "@ace/protocol";
import { PublicToolError, PublicToolCode, type Toolkit } from "@ace/mcp-server";
import type { ScreenManager } from "./manager.ts";
import { TargetBusyError } from "./target-busy.ts";
import { agentOwner } from "./agent-binding.ts";
import { computerUseTools, computerUseSchemas, computerUseHandler } from "./tools.ts";

const risks = {
  screen_measure_interaction: "external-effect",
  screen_ui_tree: "read-only",
  screen_ui_find: "read-only",
  screen_screenshot: "read-only",
  screen_ui_act: "external-effect",
  screen_click: "external-effect",
  screen_type: "external-effect",
  screen_key: "external-effect",
  screen_scroll: "external-effect",
  screen_paste: "external-effect",
  screen_request_app: "external-effect",
  screen_open_app: "external-effect",
  screen_request_foreground: "external-effect",
} satisfies Record<keyof typeof computerUseSchemas, NonNullable<ApprovalTarget["riskClass"]>>;

export function screenToolkit(manager: ScreenManager): Toolkit {
  return {
    register(registry) {
      for (const [name, input] of Object.entries(computerUseSchemas)) {
        const description = computerUseTools.find((tool) => tool.name === name)?.description;
        const risk = z.enum(["read-only", "external-effect"]).parse(Reflect.get(risks, name));
        if (!description) throw new Error("Screen tool description missing");
        registry.registerContent({
          name,
          description,
          riskClass: risk,
          input,
          capability: "screen",
          timeoutMs: name.startsWith("screen_request_")
            ? 65_000
            : name === "screen_measure_interaction"
              ? 90_000
              : name === "screen_screenshot"
                ? 30_000
                : 15_000,
          async run(args, { caller, signal }) {
            try {
              signal.throwIfAborted();
              if (name === "screen_request_app") {
                const { bundleId, reason } = computerUseSchemas.screen_request_app.parse(args);
                await manager.requestApp(bundleId, reason, caller, signal);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ approved: true, bundleId, mode: "background" }),
                    },
                  ],
                };
              }
              if (name === "screen_open_app") {
                const { bundleId } = computerUseSchemas.screen_open_app.parse(args);
                const state = await manager.openAgentApp(bundleId, caller, signal);
                signal.throwIfAborted();
                manager.agentSession(caller, state.sessionId);
                return { content: [{ type: "text", text: JSON.stringify(state) }] };
              }
              const selected = z.object({ sessionId: ScreenId.optional() }).parse(args);
              const observing =
                name === "screen_measure_interaction" &&
                computerUseSchemas.screen_measure_interaction.parse(args).action === undefined;
              const sessionId = observing
                ? manager.measurementSession(caller, selected.sessionId)
                : manager.agentSession(caller, selected.sessionId);
              if (name === "screen_request_foreground") {
                const { reason } = computerUseSchemas.screen_request_foreground.parse(args);
                const state = await manager.mode(sessionId, "foreground", signal, reason);
                manager.agentSession(caller, sessionId);
                return { content: [{ type: "text", text: JSON.stringify(state) }] };
              }
              const payload = z.record(z.string(), z.unknown()).parse(args);
              const { sessionId: _sessionId, ...actionArgs } = payload;
              const result = await computerUseHandler(
                manager,
                sessionId,
                agentOwner(caller),
                signal,
              )(name, actionArgs);
              signal.throwIfAborted();
              if (observing) manager.measurementSession(caller, sessionId);
              else manager.agentSession(caller, sessionId);
              return result;
            } catch (error) {
              if (error instanceof TargetBusyError)
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ code: error.code, holder: error.holder }),
                    },
                  ],
                };
              if (error instanceof Error && "code" in error) {
                const code = PublicToolCode.safeParse(error.code);
                if (code.success)
                  throw new PublicToolError(
                    code.data,
                    undefined,
                    "phase" in error ? error.phase : undefined,
                    "candidates" in error ? error.candidates : undefined,
                  );
              }
              throw error;
            }
          },
        });
      }
    },
  };
}
