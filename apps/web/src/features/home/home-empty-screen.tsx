import { useSidebarLoaded } from "@ace/client-react";
import { ChatsIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useStartupHold } from "@/lib/startup/startup.tsx";
import { useOnboarding } from "@/lib/provider-readiness.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { lastThread } from "./last-thread.ts";
import { topThread, useHomeList } from "./use-home-threads.ts";

/**
 * Home never rests on an empty pane: it reopens the last thread if the list still shows it, else
 * the top of the list. A genuinely empty list on a device that hasn't been through setup (the
 * first run) opens provider setup; after that an empty list shows the hint, with Add a project
 * while there is none.
 */
export function HomeEmptyScreen() {
  const { storage } = useLayout();
  const [last] = useState(() => lastThread(storage));
  const loaded = useSidebarLoaded();
  const list = useHomeList();
  const directory = useProjectDirectory();
  const projects = useProjectDialogs();
  // The last thread only while Home still lists it (not archived, inside the project filter).
  const listed =
    last !== null &&
    [list.pinned, list.active, list.recent, list.snoozed, list.settled].some((ids) =>
      ids.includes(last),
    );
  const target = listed ? last : loaded ? topThread(list) : undefined;
  // Asked only once the list is known to be empty: a returning person never waits on it.
  const onboarding = useOnboarding({ enabled: loaded && !target });
  // At boot, the startup screen waits for where Home lands rather than showing a blank pane.
  useStartupHold(!target && onboarding.data === undefined && !onboarding.isError);
  if (target) return <Navigate to="/t/$threadId" params={{ threadId: target }} replace />;
  if (onboarding.data && !onboarding.data.dismissed) return <Navigate to="/setup" replace />;
  // Until it's known whether setup comes first, the state's shape rather than a hint that flashes.
  const settled = onboarding.data !== undefined || onboarding.isError;
  if (!settled || !loaded)
    return (
      <Screen title="Home">
        <LoadingRegion
          label="Home"
          className="flex h-full flex-col items-center justify-center gap-2 px-5 py-6"
        >
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </LoadingRegion>
      </Screen>
    );
  // A chat needs no project (ADR 0099), so no project yet is just an empty list with a way to
  // add one for work in a folder.
  const noProjects = loaded && directory.loaded && directory.projects.length === 0;
  return (
    <Screen title="Home">
      <EmptyState
        icon={ChatsIcon}
        heading
        title="No threads yet"
        description={
          <>
            Start one with <Kbd shortcut="newThread" />, or search with <Kbd shortcut="palette" />.
          </>
        }
        action={
          noProjects ? (
            <button
              type="button"
              className="rounded-sm text-ui font-medium text-foreground underline-offset-4 focus-ring hover:underline"
              onClick={() => projects.open({ kind: "add", tab: "sources" })}
              onPointerEnter={projects.preload}
              onFocus={projects.preload}
            >
              Add a project
            </button>
          ) : undefined
        }
      />
    </Screen>
  );
}
