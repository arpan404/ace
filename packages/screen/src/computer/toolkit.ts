/*
 * The agent computer-use tools: screen_apps, screen_state and screen_act. They drive the
 * helper's background engine; each caller gets its own diff baseline per app.
 */
import type { Toolkit, ToolContext } from "@ace/mcp-server";
import { actLog, ranSteps, sentInput } from "./act-log.ts";
import { expandConditions, type WireAction } from "./conditions.ts";
import { appNote } from "./app-notes.ts";
import { ComputerError, type ComputerClient } from "./client.ts";
import { ComputerMemory, type ResolvedApp } from "./memory.ts";
import {
  baselineOf,
  findLines,
  outlineBody,
  outlineLines,
  screenshotNote,
  stateFooter,
  stateHeader,
  windowKey,
} from "./outline.ts";
import type { LockedUseGate } from "./locked-use-gate.ts";
import { blockedReason } from "./policy.ts";
import {
  computerSchemasFor,
  computerToolMetadataFor,
  type ComputerPlatform,
  type ComputerToolName,
} from "./schemas.ts";
import { ComputerActResult, ComputerApps, ComputerState } from "./wire.ts";
import { z } from "zod";

type Content = (
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" }
)[];
interface Result {
  content: Content;
  isError?: boolean;
}

export interface ComputerToolkitOptions {
  /** The platform the helper drives, for the tools' wording. Default macOS. */
  platform?: ComputerPlatform;
  /** The person's own list of apps agents can't use: app ids or names. */
  blockedApps?: () => readonly string[] | Promise<readonly string[]>;
  /** Told while a thread's agent looks at or acts in an app; the returned function ends it. */
  using?: (threadId: string, app: string) => () => void;
  /**
   * Locked computer use: decides whether a state or act runs inside a protected interval on a
   * locked Mac. Absent, every request goes to the helper as it is.
   */
  lockedUse?: LockedUseGate;
  /** With a route, every tool also takes `machine` to use another paired machine's apps. */
  route?: ComputerMachineRoute;
}

/**
 * Sends a computer-use tool to another paired machine (ADR 0105). That machine runs it with its
 * own computer-use switch and app rules; this side passes the tool and its arguments.
 */
export type ComputerMachineRoute = (
  call: {
    machine: string;
    tool: ComputerToolName;
    args: Record<string, unknown>;
    timeoutMs: number;
  },
  context: ToolContext,
) => Promise<unknown>;

/** The optional `machine` argument every computer-use tool takes when routing is available. */
const machineInput = {
  machine: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
    .optional()
    .describe("Another paired machine's apps (machines); omit for this machine."),
};

const Resolved = z.looseObject({ bundleId: z.string(), name: z.string(), running: z.boolean() });

function withPicture(state: ComputerState, text: string): Content {
  const content: Content = [{ type: "text", text }];
  if (state.screenshot)
    content.push({ type: "image", data: state.screenshot.jpeg, mimeType: "image/jpeg" });
  return content;
}

const callerOf = (context: ToolContext) => `${context.caller.threadId}/${context.caller.agentId}`;
const textOf = (content: Content) => (content[0]?.type === "text" ? content[0].text : "");

export function computerToolkit(
  client: ComputerClient,
  options: ComputerToolkitOptions = {},
): Toolkit {
  const memory = new ComputerMemory();
  const platform = options.platform ?? "macos";
  const computerSchemas = computerSchemasFor(platform);
  const computerToolMetadata = computerToolMetadataFor(options.platform ?? "macos");
  const personBlocked = async () => (await options.blockedApps?.()) ?? [];
  // Windows identities (cmd.exe, explorer.exe) are refused only on Windows.
  const host = options.platform === "windows" ? ("win32" as const) : undefined;

  const describe = (
    state: ComputerState,
    key: string,
    view: { full?: boolean; find?: string; ran?: readonly WireAction[] } = {},
  ): Content => {
    const lines = outlineLines(state.nodes);
    const windowId = windowKey(state);
    // A search shows a slice, so the caller's baseline for diffs stays as it was.
    const body = view.find
      ? { kind: "find" as const, text: findLines(lines, view.find) }
      : outlineBody(lines, windowId, view.full ? undefined : memory.baseline(key));
    if (!view.find) memory.remember(key, baselineOf(lines, windowId));
    const note = appNote(state.app.bundleId);
    const parts = [stateHeader(state, platform)];
    if (note && memory.firstNote(key)) parts.push(`Note: ${note}`);
    parts.push(body.text || "(the window exposes no accessible elements)");
    if (body.kind === "unchanged" && view.ran && sentInput(view.ran))
      parts.push(
        "That had no visible effect. Apps in the background ignore some input: use the control in the outline (a button or field), or add activate first if it must be a shortcut.",
      );
    const footer = stateFooter(state, body.kind === "full");
    if (footer) parts.push(footer);
    return withPicture(state, parts.join("\n\n"));
  };

  /**
   * Resolves a caller's name for an app to its bundle id, once per caller and name, and refuses
   * blocked apps before anything launches. `running` is known only on a fresh resolve.
   */
  const target = async (
    app: string,
    context: ToolContext,
  ): Promise<ResolvedApp & { key: string; running?: boolean }> => {
    const key = `${callerOf(context)}/${app.trim().toLowerCase()}`;
    let found: (ResolvedApp & { running?: boolean }) | undefined = memory.app(key);
    if (!found) {
      const fresh = Resolved.parse(
        await client.request("resolve", { app }, { signal: context.signal }),
      );
      found = fresh;
      memory.resolved(key, { bundleId: fresh.bundleId, name: fresh.name });
    }
    const blocked = blockedReason(found, await personBlocked(), host);
    if (blocked) throw new ComputerError("app_blocked", blocked);
    return { ...found, key };
  };

  /** Runs a helper request for an app, telling `using` and forgetting a vanished app. */
  const use = async (
    app: ResolvedApp & { key: string },
    context: ToolContext,
    op: "state" | "act",
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const done = options.using?.(context.caller.threadId, app.name);
    try {
      const send = (signal: AbortSignal) =>
        client.request(op, payload, { signal, app: app.bundleId });
      if (!options.lockedUse) return await send(context.signal);
      const { threadId, agentId } = context.caller;
      return await options.lockedUse(
        { threadId, agentId, app: app.bundleId, signal: context.signal },
        send,
      );
    } catch (error) {
      if (error instanceof ComputerError && error.code === "app_not_found")
        memory.forgetApp(app.key);
      throw error;
    } finally {
      done?.();
    }
  };

  const run: Record<ComputerToolName, (args: unknown, context: ToolContext) => Promise<Result>> = {
    async screen_apps(args, { signal }) {
      const { query } = computerSchemas.screen_apps.parse(args);
      const { apps } = ComputerApps.parse(
        await client.request("apps", query ? { query } : {}, { signal }),
      );
      const person = await personBlocked();
      const usable = apps.filter((app) => !blockedReason(app, person, host));
      const running = usable.filter((app) => app.running);
      const installed = usable.filter((app) => !app.running);
      const row = (app: (typeof apps)[number]) =>
        `${app.name} (${app.bundleId})${app.active ? ", frontmost" : ""}`;
      const text = [
        running.length ? `Running:\n${running.map(row).join("\n")}` : "No matching running apps.",
        ...(query
          ? [
              installed.length
                ? `Installed:\n${installed.map(row).join("\n")}`
                : "No other installed apps match.",
            ]
          : ["Pass query to search installed apps too."]),
      ].join("\n\n");
      return { content: [{ type: "text", text }] };
    },
    async screen_state(args, context) {
      const { app, window, screenshot, outline, full, find } =
        computerSchemas.screen_state.parse(args);
      const resolved = await target(app, context);
      const pictureOnly = outline === false;
      const state = ComputerState.parse(
        await use(resolved, context, "state", {
          app: resolved.bundleId,
          ...(window !== undefined ? { window } : {}),
          screenshot: pictureOnly || !!screenshot,
          ...(pictureOnly ? { outline: false } : {}),
          ...(!pictureOnly && find ? { find, findFormat: 1 } : {}),
        }),
      );
      if (pictureOnly) {
        const picture = screenshotNote(state);
        return {
          content: withPicture(
            state,
            [stateHeader(state, platform), picture].filter(Boolean).join("\n\n"),
          ),
        };
      }
      return {
        content: describe(state, `${callerOf(context)}/${state.app.bundleId}`, {
          ...(full ? { full } : {}),
          ...(find ? { find } : {}),
        }),
      };
    },
    async screen_act(args, context) {
      const { app, actions, window, screenshot, observe } = computerSchemas.screen_act.parse(args);
      const resolved = await target(app, context);
      if (resolved.running === false)
        throw new ComputerError(
          "app_not_running",
          `${resolved.name} is not running. Call screen_state first to open it.`,
        );
      const expanded = expandConditions(actions);
      let result: ComputerActResult;
      try {
        result = ComputerActResult.parse(
          await use(resolved, context, "act", {
            app: resolved.bundleId,
            actions: expanded.wire,
            ...(window !== undefined ? { window } : {}),
            screenshot: !!screenshot,
            ...(observe === false ? { observe: false } : {}),
          }),
        );
      } catch (error) {
        // Overdue or cancelled after some steps ran: say which, then why it stopped.
        const partial =
          error instanceof ComputerError ? ComputerActResult.safeParse(error.result) : undefined;
        if (error instanceof ComputerError && partial?.success && partial.data.done.length)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: [
                  ...actLog(actions, expanded, { done: partial.data.done }),
                  error.message,
                ].join("\n"),
              },
            ],
          };
        throw error;
      }
      const log = actLog(actions, expanded, result).join("\n");
      // A batch that stopped early failed, even when some steps ran.
      const failed = result.error ? { isError: true } : {};
      if (!result.state) return { content: [{ type: "text", text: log }], ...failed };
      const observed = describe(result.state, `${callerOf(context)}/${result.state.app.bundleId}`, {
        ran: ranSteps(expanded.wire, result.done),
      });
      return {
        content: [{ type: "text", text: `${log}\n\n${textOf(observed)}` }, ...observed.slice(1)],
        ...failed,
      };
    },
  };

  const route = options.route;
  return {
    register(registry) {
      for (const name of Object.keys(computerSchemas) as ComputerToolName[]) {
        const metadata = computerToolMetadata[name];
        registry.registerContent({
          name,
          title: metadata.title,
          description: metadata.description,
          riskClass: metadata.riskClass,
          // These tools act on this computer's apps, never on outside systems.
          openWorld: false,
          input: route ? computerSchemas[name].extend(machineInput) : computerSchemas[name],
          capability: "screen",
          timeoutMs: metadata.timeoutMs,
          async run(raw, context) {
            const { machine, ...args } = z.record(z.string(), z.unknown()).parse(raw);
            if (route && typeof machine === "string")
              return route(
                { machine, tool: name, args, timeoutMs: metadata.timeoutMs - 5_000 },
                context,
              );
            try {
              return await run[name](args, context);
            } catch (error) {
              if (error instanceof ComputerError)
                return { isError: true, content: [{ type: "text", text: error.message }] };
              throw error;
            }
          },
        });
      }
    },
  };
}
