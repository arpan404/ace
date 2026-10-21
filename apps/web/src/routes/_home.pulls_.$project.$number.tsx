import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { PullRequestPage } from "@/features/forge-pages/index.ts";

/**
 * `/pulls/ace/231?tab=code`: one pull request as a page. `repo` names a repository other than
 * the project's own (`github.com/acme/ace`); `back` is the list's address it was opened from.
 */
const Search = z.object({
  tab: z.catch(z.optional(z.enum(["summary", "timeline", "code"])), undefined),
  repo: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(512))), undefined),
  back: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
});

export const Route = createFileRoute("/_home/pulls_/$project/$number")({
  validateSearch: Search,
  component: PullRequest,
});

function PullRequest() {
  const { project, number } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return (
    <PullRequestPage
      project={project}
      number={parsed}
      repo={search.repo}
      tab={search.tab}
      back={search.back}
      onTab={(tab) => void navigate({ search: (current) => ({ ...current, tab }), replace: true })}
    />
  );
}
