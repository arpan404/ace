import { useState } from "react";
import type { ThreadRef } from "../sources/index.ts";
import { triggerAt, type Trigger } from "./draft.ts";
import { useSuggestions, type Suggestion, type Suggestions } from "./suggestions.tsx";
import { bestRow, pickerRows } from "@ace/ui-core";
import { useMentionDevices } from "../mentions/index.ts";
import type { MentionMember } from "./composer-props.ts";

/**
 * What `@` offers in a Spade chat (ADR 0194): the club's members with their faces, inserted as
 * plain names Spade routes by, then the fleet's devices as chips, matched as the thread's picker
 * matches.
 */
function spadeSuggestions(
  members: readonly MentionMember[],
  devices: ReturnType<typeof useMentionDevices>,
  query: string,
): Suggestions {
  const rows = pickerRows<Suggestion>(
    [
      ...members.map((member) => ({
        section: "Spade bots" as const,
        label: member.name,
        detail: "In this club",
        payload: {
          insert: `@${member.name}`,
          label: member.name,
          kind: "mention" as const,
          group: "Spade bots",
          plain: true,
          ...(member.avatar ? { picture: { kind: "bot" as const, avatar: member.avatar } } : {}),
        },
      })),
      ...devices.map((device) => ({
        section: "Devices" as const,
        label: device.name,
        detail: device.detail,
        payload: {
          insert: `@${device.name}`,
          label: device.name,
          detail: device.detail,
          kind: "mention" as const,
          group: "Devices",
          device: device.item,
          picture: {
            kind: "device" as const,
            device: device.kind,
            model: device.model,
            os: device.os,
          },
        },
      })),
    ],
    query,
  );
  const items = rows.map((row) => row.payload);
  return items.length
    ? { state: "ready", kind: "mention", items, best: bestRow(rows) }
    : { state: "closed" };
}

/**
 * The suggestion list for the token at the caret (`@file`, a leading `/command`, or the + menu
 * while `adding`), its highlighted row, and the token Esc dismissed so it stays closed until
 * the person types again.
 */
export function useComposerSuggestions(
  thread: ThreadRef,
  text: string,
  caret: number,
  recent: () => readonly string[],
  /** No project or commands to suggest (Spade): `@`, `/` and + open no list. */
  off = false,
  /** While `off`: names `@` offers instead, inserted as plain text. */
  names?: readonly MentionMember[],
) {
  "use no memo";
  const [dismissed, setDismissed] = useState<number>();
  const [highlight, setHighlight] = useState({ key: "", index: 0 });
  const [adding, setAdding] = useState(false);
  const found = adding
    ? { kind: "command" as const, query: "", start: caret, end: caret }
    : triggerAt(text, caret);
  const open = found && found.start !== dismissed ? found : undefined;
  const named = off && open?.kind === "mention" ? open : undefined;
  const trigger: Trigger | undefined = off ? named : open;
  const listed = useSuggestions(thread, named ? undefined : trigger, recent, adding);
  const devices = useMentionDevices(!!named);
  const suggestions = named ? spadeSuggestions(names ?? [], devices, named.query) : listed;
  const items = suggestions.state === "ready" ? suggestions.items : [];
  // The highlight resets whenever the token being completed changes.
  const listKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : "";
  // Until the arrows move it, the best match is highlighted, wherever its section sits.
  const best = suggestions.state === "ready" ? (suggestions.best ?? 0) : 0;
  const active = Math.min(
    highlight.key === listKey ? highlight.index : best,
    Math.max(0, items.length - 1),
  );
  return {
    trigger,
    suggestions,
    items,
    active,
    adding,
    setAdding,
    /** Keep the token starting here closed; undefined lets any token open the list again. */
    setDismissed,
    /** Keep the token at the end of `next` closed, for text the person didn't type there. */
    dismissAt: (next: string, at: number) => setDismissed(triggerAt(next, at)?.start),
    highlight: (index: number) => setHighlight({ key: listKey, index }),
    /** Close the list for the token being completed (Esc, a click away). */
    close: () => {
      setAdding(false);
      setDismissed(trigger?.start);
    },
  };
}
