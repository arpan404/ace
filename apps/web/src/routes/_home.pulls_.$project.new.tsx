import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { NewPullRequestPage } from "@/features/forge-pages/index.ts";

/**
 * `/pulls/ace/new?head=fix/x`: a new pull request as a page. `base` and `head` preselect its
 * branches; `back` is the list's address it was opened from.
 */
const Search = z.object({
  base: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
  head: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
  back: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
});

export const Route = createFileRoute("/_home/pulls_/$project/new")({
  validateSearch: Search,
  component: NewPullRequest,
});

function NewPullRequest() {
  const { project } = Route.useParams();
  const search = Route.useSearch();
  return (
    <NewPullRequestPage
      key={project}
      project={project}
      base={search.base}
      head={search.head}
      back={search.back}
    />
  );
}
