import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { NewIssuePage } from "@/features/forge-pages/index.ts";

/** `/issues/ace/new`: a new issue as a page; `back` is the list's address it was opened from. */
const Search = z.object({
  back: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
});

export const Route = createFileRoute("/_home/issues_/$project/new")({
  validateSearch: Search,
  component: NewIssue,
});

function NewIssue() {
  const { project } = Route.useParams();
  const { back } = Route.useSearch();
  return <NewIssuePage key={project} project={project} back={back} />;
}
