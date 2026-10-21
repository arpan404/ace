import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { IssuePage } from "@/features/forge-pages/index.ts";

/** `/issues/ace/240`: one issue as a page; `back` is the list's address it was opened from. */
const Search = z.object({
  back: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
});

export const Route = createFileRoute("/_home/issues_/$project/$number")({
  validateSearch: Search,
  component: Issue,
});

function Issue() {
  const { project, number } = Route.useParams();
  const { back } = Route.useSearch();
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return <IssuePage key={`${project}#${parsed}`} project={project} number={parsed} back={back} />;
}
