import { ThreadId, type CatalogEntry } from "@ace/protocol";
import {
  bestRow,
  catalogMark,
  pickerRows,
  type ComposerSuggestion,
  type MentionTab,
  type PickerRow,
  type PickerSection,
} from "@ace/ui-core";
import type { MentionPicture } from "./mention-mark.tsx";
import { avatarJson } from "./avatar-json.ts";
import type { useMentionSources } from "./use-mention-sources.ts";

/*
 * The `@` picker's rows (ADR 0198), in its fixed order of sections, filtered by what was typed:
 * other threads' agents, Spade bots, clubs, devices, apps, then the files, tabs and threads the
 * composer always offered. Each row carries its picture and what picking it names.
 */

export type MentionRow<Tab extends MentionTab> = ComposerSuggestion<Tab> & {
  picture: MentionPicture;
};

const groupSections: Record<string, PickerSection> = {
  Files: "Files",
  "Browser tabs": "Browser tabs",
  Threads: "Threads",
};

const withAvatar = <T>(avatar: T | undefined) => (avatar === undefined ? {} : { avatar });

export function mentionRows<Tab extends MentionTab>(input: {
  query: string;
  sources: ReturnType<typeof useMentionSources>;
  /** The catalog: its apps (a Codex app, an app's tools, a plugin named for one) are listed. */
  entries: readonly CatalogEntry[];
  /** Files, tabs and threads, as `mentionSuggestions` lists them. */
  base: readonly ComposerSuggestion<Tab>[];
}): { rows: MentionRow<Tab>[]; best: number } {
  const { sources } = input;
  type Payload = Omit<ComposerSuggestion<Tab>, "group" | "label"> & { picture: MentionPicture };
  const rows: (Omit<PickerRow<Payload>, "rank"> & { matched?: number | undefined })[] = [
    ...sources.agents.map((agent) => ({
      section: "Agents" as const,
      label: agent.title,
      detail: agent.detail,
      payload: {
        addressee: {
          kind: "agent" as const,
          threadId: ThreadId.parse(agent.threadId),
          title: agent.title,
          ...(agent.provider ? { provider: agent.provider } : {}),
        },
        picture: { kind: "agent", provider: agent.provider } satisfies MentionPicture,
      },
    })),
    ...sources.bots.map((bot) => ({
      section: "Spade bots" as const,
      label: bot.name,
      detail: bot.detail,
      payload: {
        addressee: {
          kind: "bot" as const,
          id: bot.id,
          name: bot.name,
          avatar: avatarJson(bot.avatar),
        },
        picture: { kind: "bot", avatar: bot.avatar } satisfies MentionPicture,
      },
    })),
    ...sources.clubs.map((club) => ({
      section: "Clubs" as const,
      label: club.name,
      detail: club.detail,
      payload: {
        addressee: {
          kind: "club" as const,
          id: club.id,
          name: club.name,
          faces: club.members
            .slice(0, 3)
            .map((member) =>
              Object.assign({ id: member.agent }, withAvatar(avatarJson(member.avatar))),
            ),
        },
        picture: { kind: "club", members: club.members } satisfies MentionPicture,
      },
    })),
    ...sources.devices.map((device) => ({
      section: "Devices" as const,
      label: device.name,
      detail: device.detail,
      payload: {
        device: device.item,
        picture: {
          kind: "device",
          device: device.kind,
          model: device.model,
          os: device.os,
        } satisfies MentionPicture,
      },
    })),
    ...input.entries
      .filter(
        (entry) => entry.invocation.type !== "unavailable" && catalogMark(entry).kind === "app",
      )
      .map((entry) => ({
        section: "Apps" as const,
        label: entry.title ?? entry.name,
        detail: entry.description.split("\n")[0]?.trim() || "App",
        payload: { entry, picture: { kind: "catalog", entry } satisfies MentionPicture },
      })),
    ...input.base.map((item, index) => ({
      section: groupSections[item.group] ?? ("Files" as const),
      label: item.label,
      detail: item.detail ?? "",
      // The daemon's file index already matched these, in its order.
      matched: item.path ? 2 + index / 1000 : undefined,
      payload: {
        ...item,
        picture: (item.path
          ? { kind: "file", path: item.path }
          : item.tab
            ? { kind: "tab", favicon: undefined }
            : { kind: "thread" }) satisfies MentionPicture,
      },
    })),
  ];
  const ranked = pickerRows(rows, input.query);
  return {
    rows: ranked.map((row) => ({
      ...row.payload,
      group: row.section,
      label: row.label,
      detail: row.detail || undefined,
    })),
    best: bestRow(ranked),
  };
}
