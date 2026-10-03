import type { SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { railViews, type RailView } from "@/features/shell/views.ts";
import { keymap } from "@/lib/keymap.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

export type PaletteIcon = "thread" | "view" | "action" | "theme";
export interface PaletteCommand {
  id: string;
  label: string;
  /** Muted text after the label (the project on a thread). */
  detail?: string;
  /** Keymap notation, shown at the right. */
  keys?: string;
  icon: PaletteIcon;
  run(): void;
}
export interface PaletteGroup {
  value: string;
  items: PaletteCommand[];
}

interface ThreadTarget {
  id: string;
  workspaceId: string;
  title: string;
}
const readTargets = (reader: SidebarReader): ThreadTarget[] =>
  reader.ids.toReversed().flatMap((id) => {
    const entry = reader.thread(id);
    return entry && entry.archivedAt === undefined
      ? [{ id, workspaceId: entry.workspaceId, title: entry.title }]
      : [];
  });
const targetsEqual = (a: ThreadTarget[], b: ThreadTarget[]) =>
  a.length === b.length && a.every((t, i) => t.id === b[i]?.id && t.title === b[i]?.title);

const noTargets: ThreadTarget[] = [];
type Destination =
  | RailView["to"]
  | "/new"
  | "/deck/new"
  | "/more/accounts"
  | "/more/search"
  | "/settings";

/** Commands are plain data so features register entries without touching the dialog. */
export function usePaletteGroups(close: () => void): PaletteGroup[] {
  const navigate = useNavigate();
  const { themes, update } = useTheme();
  // Titles can change, but the palette is short-lived; ids cover membership.
  const threads = useSidebar(["ids"], readTargets, targetsEqual) ?? noTargets;
  return useMemo(() => {
    const go = (to: Destination) => () => {
      close();
      void navigate({ to });
    };
    const groups: PaletteGroup[] = [
      {
        value: "Threads",
        items: threads.map((thread) => ({
          id: `thread-${thread.id}`,
          label: thread.title,
          detail: thread.workspaceId,
          icon: "thread",
          run: () => {
            close();
            void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
          },
        })),
      },
      {
        value: "Create",
        items: [
          {
            id: "new-thread",
            label: "New thread",
            keys: keymap.newThread.keys,
            icon: "action",
            run: go("/new"),
          },
          {
            id: "new-deck",
            label: "New deck",
            keys: keymap.newDeck.keys,
            icon: "action",
            run: go("/deck/new"),
          },
        ],
      },
      {
        value: "Go to",
        items: [
          ...railViews.map((view): PaletteCommand => {
            const command: PaletteCommand = {
              id: `go-${view.id}`,
              label: view.label,
              icon: "view",
              run: go(view.to),
            };
            if (view.shortcut) command.keys = keymap[view.shortcut].keys;
            return command;
          }),
          { id: "go-accounts", label: "Usage & accounts", icon: "view", run: go("/more/accounts") },
          { id: "go-search", label: "Search", icon: "view", run: go("/more/search") },
          {
            id: "go-settings",
            label: "Settings",
            keys: keymap.settings.keys,
            icon: "view",
            run: go("/settings"),
          },
        ],
      },
      {
        value: "Theme",
        items: [
          {
            id: "theme-system",
            label: "Match system theme",
            icon: "theme",
            run: () => {
              close();
              update({ theme: "system" });
            },
          },
          ...themes.map((theme) => ({
            id: `theme-${theme.id}`,
            label: `Use ${theme.name} theme`,
            icon: "theme" as const,
            run: () => {
              close();
              update({ theme: theme.id });
            },
          })),
        ],
      },
    ];
    return groups.filter((group) => group.items.length > 0);
  }, [close, navigate, threads, themes, update]);
}
