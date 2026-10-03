import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { NewThreadPage } from "@/features/home/new-thread/new-thread-page.tsx";

/** `/new?project=ace&base=main`: both optional; the page falls back to remembered choices. */
const NewThreadSearch = z.object({
  project: z.string().min(1).optional().catch(undefined),
  base: z.string().min(1).optional().catch(undefined),
});

/** ⌘N. The thread is created when the first message is sent. */
export const Route = createFileRoute("/_home/new")({
  validateSearch: NewThreadSearch,
  component: NewThreadRoute,
});

function NewThreadRoute() {
  const search = Route.useSearch();
  return (
    <NewThreadPage
      key={`${search.project ?? ""}:${search.base ?? ""}`}
      project={search.project}
      base={search.base}
    />
  );
}
