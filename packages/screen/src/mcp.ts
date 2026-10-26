import { screenPublicFailure } from "./public-failure.ts";
import { z } from "zod";
import { ScreenId, type ScreenState } from "@ace/protocol";
import { type Toolkit, type ToolContext } from "@ace/mcp-server";
import type { ScreenManager } from "./manager.ts";
import { TargetBusyError } from "./target-busy.ts";
import { HelperCommandError } from "./helper.ts";
import { agentOwner } from "./agent-binding.ts";
import { computerUseHandler, settledResult } from "./tools.ts";
import { computerUseSchemas, screenToolMetadata, type ScreenToolName } from "./tool-schemas.ts";

function resultMetadata(state: ScreenState) {
  return {
    "ace/screen": {
      sessionId: state.sessionId,
      mode: state.mode,
      ...(state.target.kind === "app" || state.target.kind === "window"
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
/** What an agent needs to continue: ids, mode, target and permissions, not helper internals. */
function sessionSummary(state: ScreenState) {
  const { sessionId, mode, controller, target, permissions } = state;
  return { sessionId, mode, controller, target, permissions };
}
const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];

async function openApp(manager: ScreenManager, args: unknown, context: ToolContext) {
  const { caller, signal } = context;
  const { bundleId, windowId, url, mode } = computerUseSchemas.screen_open_app.parse(args);
  const isWindows = (await manager.capabilities())?.platform === "windows";
  if (isWindows) {
    if (mode === "background")
      throw new HelperCommandError("foreground_required", "Windows needs foreground input");
    if (url !== undefined)
      throw new HelperCommandError("not_supported", "Windows does not open URLs");
  }
  const opened = await manager.openAgentApp(bundleId, caller, signal, windowId);
  signal.throwIfAborted();
  const sessionId = manager.agentSession(caller, opened.sessionId);
  const effectiveMode = mode ?? (isWindows ? "foreground" : undefined);
  if (effectiveMode !== undefined && manager.state(sessionId).mode !== effectiveMode)
    manager.mode(sessionId, effectiveMode);
  const windows = { windows: opened.windows, selectedWindowId: opened.selectedWindowId };
  const afterUrl =
    url === undefined
      ? undefined
      : await settledResult(
          manager,
          sessionId,
          agentOwner(caller),
          await manager.appOperation(sessionId, { op: "open.url", url }, agentOwner(caller), () =>
            signal.throwIfAborted(),
          ),
        );
  const state = manager.state(sessionId);
  return {
    content: text({
      ...sessionSummary(state),
      ...windows,
      ...(afterUrl ? { opened: url, ...afterUrl } : {}),
    }),
    _meta: resultMetadata(state),
  };
}

export function screenToolkit(manager: ScreenManager): Toolkit {
  return {
    register(registry) {
      for (const [key, input] of Object.entries(computerUseSchemas)) {
        const name = key as ScreenToolName;
        const metadata = screenToolMetadata[name];
        registry.registerContent({
          name,
          title: metadata.title,
          description: metadata.description,
          riskClass: metadata.riskClass,
          // Screen tools act on this machine's windows, never on outside systems.
          openWorld: false,
          input,
          capability: "screen",
          timeoutMs: metadata.timeoutMs,
          async run(args, context) {
            const { caller, signal } = context;
            let selectedSession: string | undefined;
            try {
              signal.throwIfAborted();
              if (name === "screen_windows") {
                const { bundleId } = computerUseSchemas.screen_windows.parse(args);
                return { content: text(await manager.listAppWindows(bundleId)) };
              }
              if (name === "screen_open_app") return await openApp(manager, args, context);
              const selected = z.object({ sessionId: ScreenId.optional() }).parse(args);
              const observing =
                name === "screen_measure" &&
                computerUseSchemas.screen_measure.parse(args).action === undefined;
              const sessionId = observing
                ? manager.measurementSession(caller, selected.sessionId)
                : manager.agentSession(caller, selected.sessionId);
              selectedSession = sessionId;
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
                  content: text({ code: error.code, holder: error.holder }),
                };
              throw screenPublicFailure(error, permissionGap(manager, selectedSession));
            }
          },
        });
      }
    },
  };
}

function permissionGap(manager: ScreenManager, sessionId: string | undefined) {
  if (!sessionId) return undefined;
  try {
    const permissions = manager.state(sessionId).permissions;
    return !permissions.screenRecording
      ? "screenRecording"
      : !permissions.accessibility
        ? "accessibility"
        : undefined;
  } catch {
    /* A stopped session no longer has permission state. */
    return undefined;
  }
}
