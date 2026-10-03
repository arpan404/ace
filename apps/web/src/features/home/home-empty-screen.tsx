import { useSidebarThread } from "@ace/client-react";
import { ChatsIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { lastThread } from "./last-thread.ts";

/** Home with no thread open: back to the last thread if it is still here, else a hint. */
export function HomeEmptyScreen() {
  const { storage } = useLayout();
  const [last] = useState(() => lastThread(storage));
  const entry = useSidebarThread(last ?? "");
  if (last && entry && !entry.archivedAt)
    return <Navigate to="/t/$threadId" params={{ threadId: last }} replace />;
  return (
    <Screen title="Home">
      <EmptyState
        icon={ChatsIcon}
        title="Pick a thread"
        description={
          <>
            Choose one from the list, start a new one with <Kbd keys="mod+n" />, or search with{" "}
            <Kbd keys="mod+k" />.
          </>
        }
      />
    </Screen>
  );
}
