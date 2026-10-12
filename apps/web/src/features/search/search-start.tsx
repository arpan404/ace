import {
  ArchiveIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  NotePencilIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { formatAge } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import type { KeymapId } from "@/lib/keymap.ts";
import { cn } from "@/lib/cn.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";

/*
 * What search shows before anything is typed: things to act on, not an explanation. Recent
 * threads, recent searches and a few quick commands, each a row that does something.
 */

const recentThreadCount = 5;

/** The most recently active threads that aren't archived, newest first. */
const recentThreadsOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids
    .flatMap((id) => {
      const entry = reader.thread(id);
      return entry && entry.archivedAt === undefined ? [entry] : [];
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, recentThreadCount);
const noThreads: ThreadListEntry[] = [];

const row =
  "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-ui focus-ring-inset hover:bg-accent";

function Group(props: { id: string; label: string; children: ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="pb-1">
      <h2 id={props.id} className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
        {props.label}
      </h2>
      <ul className="flex flex-col gap-px">{props.children}</ul>
    </section>
  );
}

const commands: readonly {
  label: string;
  icon: IconGlyph;
  to: "/new" | "/settings" | "/archived";
  shortcut?: KeymapId;
}[] = [
  { label: "New thread", icon: NotePencilIcon, to: "/new", shortcut: "newThread" },
  { label: "Settings", icon: GearSixIcon, to: "/settings", shortcut: "settings" },
  { label: "Archived threads", icon: ArchiveIcon, to: "/archived" },
];

export function SearchStart(props: {
  recent: readonly string[];
  onPick(query: string): void;
  onForget(query: string): void;
  onClose(): void;
}) {
  const navigate = useNavigate();
  const now = useNow();
  const projectName = useProjectName();
  const threads = useSidebarAll(recentThreadsOf, arrayEqual) ?? noThreads;
  const go = (run: () => Promise<void>) => {
    props.onClose();
    void run();
  };
  return (
    <div className="flex flex-col gap-1">
      {threads.length > 0 && (
        <Group id="search-start-threads" label="Recent threads">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className={row}
                onClick={() =>
                  go(() => navigate({ to: "/t/$threadId", params: { threadId: thread.id } }))
                }
              >
                <ProviderIconTip provider={thread.provider} />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {projectName(thread.workspaceId)} · {formatAge(thread.updatedAt, now)}
                </span>
              </button>
            </li>
          ))}
        </Group>
      )}
      {props.recent.length > 0 && (
        <Group id="search-start-recent" label="Recent searches">
          {props.recent.map((query) => (
            <li key={query} className="group flex items-center gap-1 rounded-md hover:bg-accent">
              <button
                type="button"
                onClick={() => props.onPick(query)}
                className={cn(row, "hover:bg-transparent")}
              >
                <Icon icon={ClockCounterClockwiseIcon} className="text-muted-foreground" />
                <span className="truncate">{query}</span>
              </button>
              <IconButton
                icon={XIcon}
                size="sm"
                label={`Forget "${query}"`}
                className="mr-1.5"
                onClick={() => props.onForget(query)}
              />
            </li>
          ))}
        </Group>
      )}
      <Group id="search-start-commands" label="Commands">
        {commands.map((command) => (
          <li key={command.to}>
            <button
              type="button"
              className={row}
              onClick={() => go(() => navigate({ to: command.to }))}
            >
              <Icon icon={command.icon} className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              {command.shortcut && <Kbd shortcut={command.shortcut} />}
            </button>
          </li>
        ))}
      </Group>
    </div>
  );
}
