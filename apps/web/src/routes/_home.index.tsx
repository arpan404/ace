import { createFileRoute } from "@tanstack/react-router";
import { ChatsIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Screen } from "@/features/shell/screen.tsx";

export const Route = createFileRoute("/_home/")({ component: Home });

function Home() {
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
