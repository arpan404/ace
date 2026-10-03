import { createFileRoute } from "@tanstack/react-router";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <h1 className="sr-only">ace</h1>
        <EmptyTitle>Pick a thread</EmptyTitle>
        <EmptyDescription>
          Choose a thread from the sidebar, or press <Kbd>⌘K</Kbd> to search.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
