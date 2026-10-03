import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { NewThreadPage } from "@/features/home/index.ts";

/** `/new?project=ace&base=main`: both optional; the page falls back to remembered choices. */
const NewThreadSearch = z.object({
  project: z.catch(z.optional(z.string().check(z.minLength(1))), undefined),
  base: z.catch(z.optional(z.string().check(z.minLength(1))), undefined),
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
