/*
 * The agent computer-use tools: screen_apps, screen_state and screen_act. They drive the
 * helper's background engine; each caller gets its own diff baseline per app.
 */
import type { Toolkit, ToolContext } from "@ace/mcp-server";
import { appNote } from "./app-notes.ts";
import { ComputerError, type ComputerClient } from "./client.ts";
import {
  baselineOf,
  findLines,
  outlineBody,
  outlineLines,
  stateFooter,
  stateHeader,
  windowKey,
  type OutlineBaseline,
} from "./outline.ts";
import { blockedReason } from "./policy.ts";
import {
  computerSchemas,
  computerToolMetadata,
  type ComputerAction,
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

const Resolved = z.looseObject({ bundleId: z.string(), name: z.string(), running: z.boolean() });
const maxBaselines = 256;
/** Steps whose effect depends on the app routing a command, which background apps may skip. */
const commandSteps: ReadonlySet<string> = new Set(["key", "menu", "paste"]);

/** Per caller and app: the last outline seen, and whether its app note was shown. */
class Memory {
  private readonly baselines = new Map<string, OutlineBaseline>();
  private readonly noted = new Set<string>();
  baseline(key: string) {
    return this.baselines.get(key);
  }
  remember(key: string, baseline: OutlineBaseline) {
    this.baselines.delete(key);
    this.baselines.set(key, baseline);
    if (this.baselines.size > maxBaselines) {
      const oldest = this.baselines.keys().next().value;
      if (oldest !== undefined) this.baselines.delete(oldest);
    }
  }
  firstNote(key: string) {
    if (this.noted.has(key)) return false;
    if (this.noted.size > maxBaselines) this.noted.clear();
    this.noted.add(key);
    return true;
  }
}

const callerKey = (context: ToolContext, bundleId: string) =>
  `${context.caller.threadId}/${context.caller.agentId}/${bundleId}`;

export function computerToolkit(client: ComputerClient): Toolkit {
  const memory = new Memory();

  const describe = (
    state: ComputerState,
    key: string,
    options: { full?: boolean; find?: string; acted?: readonly ComputerAction[] } = {},
  ): Content => {
    const lines = outlineLines(state.nodes);
    const windowId = windowKey(state);
    // A search shows a slice, so the caller's baseline for diffs stays as it was.
    const body = options.find
      ? { kind: "find" as const, text: findLines(lines, options.find) }
      : outlineBody(lines, windowId, options.full ? undefined : memory.baseline(key));
    if (!options.find) memory.remember(key, baselineOf(lines, windowId));
    const note = appNote(state.app.bundleId);
    const parts = [stateHeader(state)];
    if (note && memory.firstNote(key)) parts.push(`Note: ${note}`);
    parts.push(body.text || "(the window exposes no accessible elements)");
    if (body.kind === "unchanged" && options.acted?.some((action) => commandSteps.has(action.type)))
      parts.push(
        "That had no visible effect. Apps in the background ignore some commands: use the control in the outline (a button or field), or add activate first if it must be a shortcut.",
      );
    const footer = stateFooter(state, body.kind === "full");
    if (footer) parts.push(footer);
    const content: Content = [{ type: "text", text: parts.join("\n\n") }];
    if (state.screenshot)
      content.push({ type: "image", data: state.screenshot.jpeg, mimeType: "image/jpeg" });
    return content;
  };

  /** Resolves a name to its bundle id and refuses blocked apps before anything launches. */
  const resolve = async (app: string, signal: AbortSignal) => {
    const resolved = Resolved.parse(await client.request("resolve", { app }, { signal }));
    const blocked = blockedReason(resolved.bundleId);
    if (blocked) throw new ComputerError("app_blocked", blocked);
    return resolved;
  };

  const run: Record<ComputerToolName, (args: unknown, context: ToolContext) => Promise<Result>> = {
    async screen_apps(args, { signal }) {
      const { query } = computerSchemas.screen_apps.parse(args);
      const { apps } = ComputerApps.parse(
        await client.request("apps", query ? { query } : {}, { signal }),
      );
      const usable = apps.filter((app) => !blockedReason(app.bundleId));
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
      const { app, window, screenshot, full, find } = computerSchemas.screen_state.parse(args);
      const resolved = await resolve(app, context.signal);
      const state = ComputerState.parse(
        await client.request(
          "state",
          {
            app: resolved.bundleId,
            ...(window !== undefined ? { window } : {}),
            screenshot: !!screenshot,
          },
          { signal: context.signal },
        ),
      );
      return {
        content: describe(state, callerKey(context, resolved.bundleId), {
          ...(full ? { full } : {}),
          ...(find ? { find } : {}),
        }),
      };
    },
    async screen_act(args, context) {
      const { app, actions, window, screenshot } = computerSchemas.screen_act.parse(args);
      const resolved = await resolve(app, context.signal);
      if (!resolved.running)
        throw new ComputerError(
          "app_not_running",
          `${resolved.name} is not running. Call screen_state first to open it.`,
        );
      const result = ComputerActResult.parse(
        await client.request(
          "act",
          {
            app: resolved.bundleId,
            actions,
            ...(window !== undefined ? { window } : {}),
            screenshot: !!screenshot,
          },
          { signal: context.signal },
        ),
      );
      const log = result.done.map((step, index) => `${index + 1}. ${step}`);
      if (result.error) {
        const failed = actions[result.error.index];
        log.push(
          `Action ${result.error.index + 1}${failed ? ` (${failed.type})` : ""} failed: ${result.error.message}${
            result.error.index < actions.length - 1 ? " The actions after it did not run." : ""
          }`,
        );
      }
      const content: Content = [{ type: "text", text: log.join("\n") }];
      if (result.state) {
        const [first, ...rest] = describe(result.state, callerKey(context, resolved.bundleId), {
          acted: actions,
        });
        if (first?.type === "text")
          content[0] = { type: "text", text: `${log.join("\n")}\n\n${first.text}` };
        content.push(...rest);
      }
      return { content, ...(result.error && result.done.length === 0 ? { isError: true } : {}) };
    },
  };

  return {
    register(registry) {
      for (const name of Object.keys(computerSchemas) as ComputerToolName[]) {
        const metadata = computerToolMetadata[name];
        registry.registerContent({
          name,
          title: metadata.title,
          description: metadata.description,
          riskClass: metadata.riskClass,
          // These tools act on this Mac's apps, never on outside systems.
          openWorld: false,
          input: computerSchemas[name],
          capability: "screen",
          timeoutMs: metadata.timeoutMs,
          async run(args, context) {
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
