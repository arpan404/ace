import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { PullRequestPage, repositoryFromParam } from "@/features/forge-pages/index.ts";

const Tab = z.enum(["summary", "timeline", "code"]);

/**
 * `?tab=code`: the PR's open tab. `?repo=github.com/acme/ace`: a PR outside the project's own
 * repository, opened from a link in another PR.
 */
const PullRequestSearch = z.object({
  tab: z.catch(z.optional(Tab), undefined),
  repo: z.catch(z.optional(z.string().check(z.maxLength(512))), undefined),
});

export const Route = createFileRoute("/_forge/pulls/$project/$number")({
  validateSearch: PullRequestSearch,
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
      repository={repositoryFromParam(search.repo)}
      tab={search.tab ?? "summary"}
      onTab={(tab) => {
        const next = Tab.safeParse(tab);
        void navigate({
          search: (current) => ({
            ...current,
            tab: next.success && next.data !== "summary" ? next.data : undefined,
          }),
          replace: true,
        });
      }}
    />
  );
}
