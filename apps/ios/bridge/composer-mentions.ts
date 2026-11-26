import { ThreadId, type CatalogEntry, type DeviceContextItem } from "@ace/protocol";
import {
  agentDetail,
  catalogMark,
  deviceDetail,
  mentionSuggestions,
  pickerRows,
  type ComposerSuggestion,
  type MentionTab,
  type MentionThread,
  type PickerAgent,
  type PickerDevice,
  type PickerRow,
  type PickerSection,
} from "@ace/ui-core";
import type { RowSource } from "./composer-rows.ts";

/*
 * The phone's `@` list: the same sections in the same order as the web's (`mention-picker.ts`),
 * from the facts its bridge can read (ADR 0198). Another thread's working agent, the devices of
 * the machine the thread runs on and the catalog's apps join the files, browser tabs and threads
 * the composer always offered; `suggestionToken` turns a picked row into the reference the web
 * sends. Pure: `composer-suggest.ts` brings the facts.
 */

/** Another thread's agent the message can go to: one working or waiting now. */
export type MentionAgent = PickerAgent & { workspaceId: string };

/** A device of the machine this thread runs on, as `@` a device names it. */
function deviceItem(device: PickerDevice): DeviceContextItem {
  return {
    type: "device",
    id: device.id,
    name: device.name,
    kind: device.kind,
    machine: device.machine,
    ...(device.os ? { os: device.os } : {}),
    ...(device.model ? { model: device.model } : {}),
    online: device.online,
  };
}

/** The section a base row (a file, tab or thread) belongs to. */
const groupSections: Record<string, PickerSection> = {
  Files: "Files",
  "Browser tabs": "Browser tabs",
  Threads: "Threads",
};

/** A row's stable id within the `@` list. */
function rowId(item: ComposerSuggestion): string {
  if (item.path) return `file:${item.path}`;
  if (item.tab) return `tab:${item.tab.tabId}`;
  if (item.addressee)
    return item.addressee.kind === "agent"
      ? `agent:${item.addressee.threadId}`
      : `${item.addressee.kind}:${item.addressee.id}`;
  if (item.device) return `device:${item.device.machine.id}/${item.device.id}`;
  if (item.threadId) return `thread:${item.threadId}`;
  if (item.entry) return `app:${item.entry.id}`;
  return `mention:${item.label}`;
}

export interface MentionRowInput {
  query: string;
  /** Files mentioned lately, offered first while nothing is typed. */
  recent: readonly string[];
  /** Files the daemon completed for the query. */
  paths: readonly string[];
  tabs: readonly MentionTab[];
  threads: readonly MentionThread[];
  /** The thread being written in (undefined for a draft), and its project. */
  threadId: string | undefined;
  workspaceId: string;
  /** Other threads of the project: only their working or waiting agents are offered. */
  agents: readonly MentionAgent[];
  devices: readonly PickerDevice[];
  /** The catalog: its apps are listed under Apps. */
  entries: readonly CatalogEntry[];
}

/**
 * Every row `@` offers for `query`: agents, devices and apps, then the files, tabs and threads
 * `mentionSuggestions` lists, filtered and grouped by the shared `pickerRows` rule.
 */
export function mentionRows(input: MentionRowInput): RowSource[] {
  const { query, threadId, workspaceId } = input;
  const base = mentionSuggestions({
    query,
    recent: query ? [] : input.recent,
    paths: input.paths,
    tabs: input.tabs,
    threads: input.threads,
    threadId,
    workspaceId,
  });
  type Payload = ComposerSuggestion;
  const rows: (Omit<PickerRow<Payload>, "rank"> & { matched?: number | undefined })[] = [
    // A draft has no thread to address, and no fleet: the first message offers files alone.
    ...(threadId ? input.agents : [])
      .filter((agent) => agent.workspaceId === workspaceId && agent.threadId !== threadId)
      .map((agent) => {
        const detail = agentDetail(agent);
        return {
          section: "Agents" as const,
          label: agent.title,
          detail,
          payload: {
            group: "Agents",
            label: agent.title,
            detail,
            addressee: {
              kind: "agent" as const,
              threadId: ThreadId.parse(agent.threadId),
              title: agent.title,
              ...(agent.provider ? { provider: agent.provider } : {}),
            },
          },
        };
      }),
    ...(threadId ? input.devices : []).map((device) => {
      const detail = deviceDetail(device);
      return {
        section: "Devices" as const,
        label: device.name,
        detail,
        payload: { group: "Devices", label: device.name, detail, device: deviceItem(device) },
      };
    }),
    ...input.entries
      .filter(
        (entry) => entry.invocation.type !== "unavailable" && catalogMark(entry).kind === "app",
      )
      .map((entry) => {
        const label = entry.title ?? entry.name;
        const detail = entry.description.split("\n")[0]?.trim() || "App";
        return {
          section: "Apps" as const,
          label,
          detail,
          payload: { group: "Apps", label, detail, entry },
        };
      }),
    ...base.map((item, index) => ({
      section: groupSections[item.group] ?? ("Files" as const),
      label: item.label,
      detail: item.detail ?? "",
      // The daemon's file index already matched these, in its order.
      matched: item.path ? 2 + index / 1000 : undefined,
      payload: item,
    })),
  ];
  return pickerRows(rows, query).map((row) => {
    const item = Object.assign(row.payload, {
      group: row.section,
      label: row.label,
      detail: row.detail || undefined,
    });
    return Object.assign(item, { id: rowId(item) });
  });
}
