import { useSidebarLoaded } from "@ace/client-react";
import { ChatsIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useOnboarding } from "@/lib/provider-readiness.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { lastThread } from "./last-thread.ts";
import { topThread, useHomeList } from "./use-home-threads.ts";

/**
 * Home never rests on an empty pane: it reopens the last thread if the list still shows it, else
 * the top of the list. A genuinely empty list on a device that hasn't been through setup (the
 * first run) opens provider setup; after that, a daemon with no projects shows how to add one,
 * and an empty list the hint.
 */
export function HomeEmptyScreen() {
  const { storage } = useLayout();
  const [last] = useState(() => lastThread(storage));
  const loaded = useSidebarLoaded();
  const list = useHomeList();
  const directory = useProjectDirectory();
  // The last thread only while Home still lists it (not archived, inside the project filter).
  const listed =
    last !== null &&
    (list.pinned.includes(last) || list.active.includes(last) || list.settled.includes(last));
  const target = listed ? last : loaded ? topThread(list) : undefined;
  // Asked only once the list is known to be empty: a returning person never waits on it.
  const onboarding = useOnboarding({ enabled: loaded && !target });
  if (target) return <Navigate to="/t/$threadId" params={{ threadId: target }} replace />;
  if (onboarding.data && !onboarding.data.dismissed) return <Navigate to="/setup" replace />;
  // Until it's known whether setup comes first, show nothing rather than a hint that flashes.
  const settled = onboarding.data !== undefined || onboarding.isError;
  if (!settled) return <Screen title="Home">{null}</Screen>;
  if (loaded && directory.loaded && directory.projects.length === 0)
    return (
      <Screen title="Home">
        <ProjectsEmptyState heading />
      </Screen>
    );
  return (
    <Screen title="Home">
      {loaded && (
        <EmptyState
          icon={ChatsIcon}
          title="No threads yet"
          description={
            <>
              Start one with <Kbd keys="mod+n" />, or search with <Kbd keys="mod+k" />.
            </>
          }
        />
      )}
    </Screen>
  );
}
