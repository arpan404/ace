import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { railViews, type RailView } from "@/features/shell/index.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { useThreadCommands } from "./thread-commands.ts";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

export type { PaletteCommand, PaletteGroup, PaletteIcon } from "./types.ts";

type Destination =
  | RailView["to"]
  | "/new"
  | "/deck/new"
  | "/more/accounts"
  | "/more/search"
  | "/settings"
  | "/settings/theme-editor";

/**
 * Every ⌘K group. Commands are plain data, so features register entries without touching the
 * dialog: threads, projects and thread actions come from `thread-commands.ts`.
 */
export function usePaletteGroups(close: () => void): PaletteGroup[] {
  const navigate = useNavigate();
  const { themes, theme, update } = useTheme();
  const { layout, togglePanel, toggleTab } = useLayout();
  const threadGroups = useThreadCommands(close);
  const staticGroups = useMemo(() => {
    const run = (action: () => void) => () => {
      close();
      action();
    };
    const go = (to: Destination) => run(() => void navigate({ to }));
    const groups: PaletteGroup[] = [
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
        value: "Actions",
        items: [
          {
            id: "toggle-changes",
            label: "Toggle right panel · Changes",
            keys: keymap.changes.keys,
            icon: "action",
            run: run(() => toggleTab("right", "changes")),
          },
          {
            id: "open-agents",
            label: "Open agent tree",
            keys: keymap.agents.keys,
            icon: "action",
            run: run(() => toggleTab("right", "agents")),
          },
          {
            id: "toggle-bottom",
            label: `${layout.bottom.open ? "Hide" : "Show"} bottom panel · Terminal`,
            keys: keymap.bottomPanel.keys,
            icon: "action",
            run: run(() => togglePanel("bottom")),
          },
          {
            id: "theme-editor",
            label: "Theme editor",
            icon: "theme",
            run: go("/settings/theme-editor"),
          },
        ],
      },
      {
        value: "Theme",
        items: [
          {
            id: "theme-toggle",
            label: `Switch to ${theme.scheme === "dark" ? "light" : "dark"}`,
            icon: "theme",
            run: run(() => update({ theme: theme.scheme === "dark" ? "light" : "dark" })),
          },
          {
            id: "theme-system",
            label: "Match system theme",
            icon: "theme",
            run: run(() => update({ theme: "system" })),
          },
          ...themes.map((option): PaletteCommand => ({
            id: `theme-${option.id}`,
            label: `Use ${option.name} theme`,
            icon: "theme",
            run: run(() => update({ theme: option.id })),
          })),
        ],
      },
    ];
    return groups;
  }, [close, navigate, themes, theme.scheme, update, layout.bottom.open, togglePanel, toggleTab]);
  return useMemo(
    () => [...threadGroups, ...staticGroups].filter((group) => group.items.length > 0),
    [threadGroups, staticGroups],
  );
}
