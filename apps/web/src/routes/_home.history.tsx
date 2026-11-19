import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { HistoryPage } from "@/features/home/index.ts";

/** `/history?project=ace`: the project chip, kept in the address. */
const Search = z.object({
  project: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(4096))), undefined),
});

/** Every settled thread beside the Threads panel, grouped by week. */
export const Route = createFileRoute("/_home/history")({
  validateSearch: Search,
  component: History,
});

function History() {
  const { project } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <HistoryPage
      project={project}
      onProject={(next) => void navigate({ search: { project: next }, replace: true })}
    />
  );
}
