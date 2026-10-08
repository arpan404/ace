import { screenPublicFailure } from "./public-failure.ts";
import { z } from "zod";
import { ScreenId, type ApprovalTarget, type ScreenState } from "@ace/protocol";
import { type Toolkit } from "@ace/mcp-server";
import type { ScreenManager } from "./manager.ts";
import { TargetBusyError } from "./target-busy.ts";
import { agentOwner } from "./agent-binding.ts";
import { computerUseTools, computerUseSchemas, computerUseHandler } from "./tools.ts";

function resultMetadata(state: ScreenState) {
  return {
    "ace/screen": {
      mode: state.mode,
      ...(state.target.kind !== "display"
        ? {
            target: {
              bundleId: state.target.bundleId,
              displayName: state.target.bundleId.split(".").at(-1) ?? state.target.bundleId,
              ...(state.target.kind === "window" ? { windowId: state.target.windowId } : {}),
            },
          }
        : {}),
    },
  };
}

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
  screen_list_windows: "read-only",
  screen_select_window: "external-effect",
  screen_open_url: "external-effect",
  screen_menu: "external-effect",
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
            let selectedSession: string | undefined;
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
                  _meta: {
                    "ace/screen": {
                      mode: "background",
                      target: { bundleId, displayName: bundleId.split(".").at(-1) ?? bundleId },
                    },
                  },
                };
              }
              if (name === "screen_list_windows") {
                const { bundleId } = computerUseSchemas.screen_list_windows.parse(args);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(await manager.listAppWindows(bundleId, caller)),
                    },
                  ],
                };
              }
              if (name === "screen_open_app") {
                const { bundleId, windowId } = computerUseSchemas.screen_open_app.parse(args);
                const state = await manager.openAgentApp(bundleId, caller, signal, windowId);
                signal.throwIfAborted();
                manager.agentSession(caller, state.sessionId);
                return {
                  content: [{ type: "text", text: JSON.stringify(state) }],
                  _meta: resultMetadata(state),
                };
              }
              const selected = z.object({ sessionId: ScreenId.optional() }).parse(args);
              const observing =
                name === "screen_measure_interaction" &&
                computerUseSchemas.screen_measure_interaction.parse(args).action === undefined;
              const sessionId = observing
                ? manager.measurementSession(caller, selected.sessionId)
                : manager.agentSession(caller, selected.sessionId);
              selectedSession = sessionId;
              if (name === "screen_request_foreground") {
                const { reason } = computerUseSchemas.screen_request_foreground.parse(args);
                const state = await manager.mode(sessionId, "foreground", signal, reason);
                manager.agentSession(caller, sessionId);
                return {
                  content: [{ type: "text", text: JSON.stringify(state) }],
                  _meta: resultMetadata(state),
                };
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
              const state = manager.state(sessionId);
              return {
                ...result,
                _meta: {
                  ...result["_meta"],
                  "ace/screen": {
                    ...resultMetadata(state)["ace/screen"],
                    ...z
                      .record(z.string(), z.unknown())
                      .parse(result["_meta"]?.["ace/screen"] ?? {}),
                  },
                },
              };
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
              let permission: "screenRecording" | "accessibility" | undefined;
              if (selectedSession) {
                try {
                  const permissions = manager.state(selectedSession).permissions;
                  permission = !permissions.screenRecording
                    ? "screenRecording"
                    : !permissions.accessibility
                      ? "accessibility"
                      : undefined;
                } catch {
                  /* A stopped session no longer has permission state. */
                }
              }
              throw screenPublicFailure(error, permission);
            }
          },
        });
      }
    },
  };
}
