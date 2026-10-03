import { useSidebarLoaded } from "@ace/client-react";
import { ChatsIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { lastThread } from "./last-thread.ts";
import { useHomeArrangement } from "./use-home-threads.ts";

/**
 * Home never rests on an empty pane: it reopens the last thread if the list still shows it, else
 * the top of the list. Only a genuinely empty list shows the hint.
 */
export function HomeEmptyScreen() {
  const { storage } = useLayout();
  const [last] = useState(() => lastThread(storage));
  const loaded = useSidebarLoaded();
  const { active, settled } = useHomeArrangement();
  // The last thread only while Home still lists it (not archived, inside the project filter).
  const listed = last !== null && (active.includes(last) || settled.includes(last));
  const target = listed ? last : loaded ? active[0] : undefined;
  if (target) return <Navigate to="/t/$threadId" params={{ threadId: target }} replace />;
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
