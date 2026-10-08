import type { Item, RawPayload } from "@ace/protocol";
import {
  aceCallOf,
  aceToolSpec,
  aceToolView,
  screenStep,
  screenStepTools,
  screenStepView,
  type AceToolContext,
  type AceToolView,
  type ToolMark,
} from "./ace-tools.ts";
import { siteOf, str } from "./ace-tool-specs.ts";
import { field, mcpResultParts } from "./mcp-result.ts";

/*
 * One work log's ace steps read together. Each step learns what earlier ones said (the app the
 * agent opened, the site it went to, a device's name, an element's name behind a ref) and the
 * daemon's audit of each computer-use action is folded into the call it records, so the raw
 * `key.press · com.apple.Safari · …` notice never shows twice. Consecutive steps on one app,
 * site or device collapse into one line: "Used Safari · 8 actions · 3 failed". Pure.
 */

export type AceLogRow =
  | { kind: "step"; id: string }
  | {
      kind: "group";
      key: string;
      /** Every item the group holds, in order: its steps and the thoughts between them. */
      ids: string[];
      /** "Used Safari", "Browsed github.com". */
      label: string;
      mark: ToolMark;
      actions: number;
      failed: number;
      running: boolean;
      /** A step in it waits for approval, so it should open by itself. */
      awaiting: boolean;
    };

export interface AceLog {
  rows: AceLogRow[];
  /** What each step reads with. Steps with nothing to add are absent. */
  contexts: Record<string, AceToolContext>;
  /** The whole plan as one string, for cheap equality. */
  signature: string;
}

/** Tools whose actions the daemon audits, and so whose audit notice can be folded in. */
const audited = new Set([
  "screen_click",
  "screen_type",
  "screen_paste",
  "screen_key",
  "screen_scroll",
  "screen_ui_act",
  "screen_measure_interaction",
]);
/** Tools whose answers name elements by ref. */
const readsRefs = new Set([
  "screen_ui_tree",
  "screen_ui_find",
  "screen_ui_act",
  "screen_click",
  "screen_type",
  "screen_key",
  "ace_browser_snapshot",
  "ace_browser_find",
  "device_ui_tree",
  "device_find",
]);
const unsettled = new Set(["pending", "running", "awaiting_approval"]);
const maxNodes = 8192;

interface AgentState {
  app: string | undefined;
  site: string | undefined;
  /** Screen steps whose app is not known yet: the next app the agent names is theirs. */
  unknownApp: string[];
  /** Audited calls not yet matched with their audit, oldest first. */
  pending: { id: string; tool: string }[];
}

/** JSON text parts, parsed; anything else is skipped. */
function* jsonParts(raw: readonly RawPayload[], result: unknown): Generator<unknown> {
  const payloads = result === undefined ? raw : [{ type: "result", data: result }, ...raw];
  for (const text of mcpResultParts(payloads, 0).texts) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // Not JSON after all.
    }
  }
}

/** Every object in `value` with string `key` and `name` fields, bounded. */
function collect(value: unknown, key: string, into: Map<string, string>, test?: RegExp) {
  let visited = 0;
  const visit = (node: unknown, depth: number) => {
    if (++visited > maxNodes || depth > 24 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    const id = field(node, key);
    const name = field(node, "name");
    if (
      typeof id === "string" &&
      typeof name === "string" &&
      name.trim() &&
      (!test || test.test(id))
    )
      into.set(id, name.trim());
    for (const entry of Object.values(node)) visit(entry, depth + 1);
  };
  visit(value, 0);
}

/** Contexts for every step, and the audit notices their calls already show. */
function readContexts(ids: readonly string[], items: readonly (Item | undefined)[]) {
  const contexts: Record<string, AceToolContext> = {};
  const absorbed = new Set<string>();
  const agents = new Map<string, AgentState>();
  const refs = new Map<string, string>();
  const devices = new Map<string, string>();
  const stateOf = (agentId: string) => {
    let state = agents.get(agentId);
    if (!state)
      agents.set(
        agentId,
        (state = { app: undefined, site: undefined, unknownApp: [], pending: [] }),
      );
    return state;
  };
  const setApp = (state: AgentState, bundleId: string) => {
    state.app = bundleId;
    for (const id of state.unknownApp)
      contexts[id] = { ...contexts[id], app: contexts[id]?.app ?? { bundleId } };
    state.unknownApp = [];
  };
  for (const [index, item] of items.entries()) {
    const id = ids[index];
    if (!item || id === undefined) continue;
    const state = stateOf(item.agentId ?? "");
    const step = screenStep(item);
    if (step) {
      const tools = screenStepTools(step.action);
      const linked = step.toolCallId;
      const owner =
        linked !== undefined
          ? [...agents.values()].find((agent) => agent.pending.some((call) => call.id === linked))
          : state;
      const at =
        owner?.pending.findIndex((call) =>
          linked !== undefined ? call.id === linked : tools.includes(call.tool),
        ) ?? -1;
      const app = step.bundleId
        ? { bundleId: step.bundleId, mode: step.mode, outcome: step.outcome }
        : undefined;
      if (owner && at >= 0) {
        const [call] = owner.pending.splice(at, 1);
        absorbed.add(id);
        if (call && app) contexts[call.id] = { ...contexts[call.id], app };
      } else if (app) contexts[id] = { app };
      if (step.bundleId) setApp(owner ?? state, step.bundleId);
      continue;
    }
    const call = aceCallOf(item);
    const spec = call && aceToolSpec(call.server, call.tool);
    if (!call || !spec) continue;
    const args =
      typeof call.args === "object" && call.args !== null
        ? (call.args as Record<string, unknown>)
        : {};
    const context: AceToolContext = {};
    const ref = str(args, "ref");
    if (ref && refs.has(ref)) context.element = refs.get(ref);
    if (spec.family === "screen") {
      const named = str(args, "bundleId");
      if (named) setApp(state, named);
      if (state.app) context.app = { bundleId: state.app };
      else state.unknownApp.push(id);
      if (audited.has(call.tool)) state.pending.push({ id, tool: call.tool });
    } else if (spec.family === "browser") {
      const host = siteOf(str(args, "url"));
      if (state.site && !host) context.site = state.site;
      if (host) state.site = host;
    } else if (spec.family === "device") {
      const device = devices.get(str(args, "deviceId") ?? "");
      if (device) context.device = device;
    }
    if (Object.keys(context).length) contexts[id] = { ...contexts[id], ...context };
    // What the answer names, for the steps after it.
    if (readsRefs.has(call.tool) || call.tool === "device_list")
      for (const part of jsonParts(call.raw, call.result)) {
        if (call.tool === "device_list") collect(part, "id", devices, /^(ios|android):/);
        else collect(part, "ref", refs);
      }
  }
  return { contexts, absorbed };
}

type Open = {
  key: string;
  label: string;
  mark: ToolMark;
  ids: string[];
  /** Thoughts after its last step: they join only if another step of the group follows. */
  between: string[];
  actions: number;
  failed: number;
  running: boolean;
  awaiting: boolean;
};

/** The log's rows: steps, and consecutive steps on one subject grouped. */
export function aceToolLog(ids: readonly string[], items: readonly (Item | undefined)[]): AceLog {
  const { contexts, absorbed } = readContexts(ids, items);
  const rows: AceLogRow[] = [];
  let open: Open | undefined;
  const close = () => {
    if (!open) return;
    if (open.actions >= 2) {
      const { between: _, ...group } = open;
      rows.push({ kind: "group", ...group, key: `group:${open.ids[0]}` });
    } else for (const id of open.ids) rows.push({ kind: "step", id });
    for (const id of open.between) rows.push({ kind: "step", id });
    open = undefined;
  };
  for (const [index, item] of items.entries()) {
    const id = ids[index];
    if (id === undefined || absorbed.has(id)) continue;
    if (item?.type === "reasoning" && open) {
      open.between.push(id);
      continue;
    }
    const step = screenStep(item);
    const call = step ? undefined : aceCallOf(item);
    const view: AceToolView | undefined = step
      ? screenStepView(step)
      : call && aceToolView(call, contexts[id]);
    const subject = view?.subject;
    if (!view || !subject) {
      close();
      rows.push({ kind: "step", id });
      continue;
    }
    if (open?.key !== subject.key) {
      close();
      open = {
        key: subject.key,
        label: subject.label,
        mark: view.mark,
        ids: [],
        between: [],
        actions: 0,
        failed: 0,
        running: false,
        awaiting: false,
      };
    }
    open.ids.push(...open.between, id);
    open.between = [];
    open.actions++;
    if (view.problem) open.failed++;
    const status = item?.type === "tool_call" ? item.call.status : undefined;
    if (status && unsettled.has(status)) open.running = true;
    if (status === "awaiting_approval") open.awaiting = true;
  }
  close();
  return { rows, contexts, signature: JSON.stringify([rows, contexts]) };
}

/** "Used Safari · 8 actions · 3 failed". */
export function groupLine(group: Extract<AceLogRow, { kind: "group" }>): string {
  const parts = [group.label, `${group.actions} ${group.actions === 1 ? "action" : "actions"}`];
  if (group.failed) parts.push(`${group.failed} failed`);
  return parts.join(" · ");
}
