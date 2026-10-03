import type { SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { usePreferences } from "@/lib/preferences-context.tsx";
import type { Theme } from "@/lib/preferences.ts";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
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
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [{ id, workspaceId: entry.workspaceId, title: entry.title }] : [];
  });
const targetsEqual = (a: ThreadTarget[], b: ThreadTarget[]) =>
  a.length === b.length && a.every((t, i) => t.id === b[i]?.id && t.title === b[i]?.title);

const noTargets: ThreadTarget[] = [];

/** Commands are plain data so new features register entries without touching the dialog. */
export function usePaletteGroups(close: () => void): PaletteGroup[] {
  const navigate = useNavigate();
  const { update } = usePreferences();
  // Titles can change, but the palette is short-lived; ids cover membership.
  const threads = useSidebar(["ids"], readTargets, targetsEqual) ?? noTargets;
  return useMemo(() => {
    const go = (to: "/inbox" | "/conductor" | "/accounts" | "/settings") => () => {
      close();
      void navigate({ to });
    };
    const theme = (value: Theme) => () => {
      close();
      update({ theme: value });
    };
    return [
      {
        value: "Go to",
        items: [
          { id: "go-inbox", label: "Inbox", hint: "Needs you", run: go("/inbox") },
          { id: "go-conductor", label: "Conductor", run: go("/conductor") },
          { id: "go-accounts", label: "Accounts", run: go("/accounts") },
          { id: "go-settings", label: "Settings", run: go("/settings") },
        ],
      },
      {
        value: "Threads",
        items: threads.map((thread) => ({
          id: `thread-${thread.id}`,
          label: thread.title,
          hint: thread.workspaceId,
          run: () => {
            close();
            void navigate({
              to: "/w/$workspaceId/t/$threadId",
              params: { workspaceId: thread.workspaceId, threadId: thread.id },
            });
          },
        })),
      },
      {
        value: "Theme",
        items: [
          { id: "theme-light", label: "Use light theme", run: theme("light") },
          { id: "theme-dark", label: "Use dark theme", run: theme("dark") },
          { id: "theme-system", label: "Match system theme", run: theme("system") },
        ],
      },
    ].filter((group) => group.items.length > 0);
  }, [close, navigate, threads, update]);
}
