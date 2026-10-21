import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { PullRequestsPage, type PullsSearch } from "@/features/forge-pages/index.ts";

const text = (max: number) =>
  z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(max))), undefined);
const choice = <T extends string>(values: readonly [T, ...T[]]) =>
  z.catch(z.optional(z.enum(values)), undefined);

/**
 * `/pulls?state=merged&who=reviewing&labels=["bug"]&pr=231`: every filter, the sort, the search
 * and the pull request open beside the list, so a link or a reload shows the same list.
 */
const Search = z.object({
  project: text(512),
  who: choice(["all", "authored", "reviewing"]),
  state: choice(["open", "merged", "closed", "all"]),
  sort: choice(["ready", "updated", "largest", "smallest"]),
  draft: choice(["only", "hide"]),
  review: choice(["approved", "changes", "required", "none"]),
  checks: choice(["passing", "failing"]),
  author: text(100),
  labels: z.catch(
    z.optional(z.array(z.string().check(z.maxLength(100))).check(z.maxLength(20))),
    undefined,
  ),
  q: text(256),
  pr: z.catch(z.optional(z.number().check(z.int(), z.positive())), undefined),
  repo: text(512),
  tab: choice(["summary", "timeline", "code"]),
});

/** Pull requests beside the thread list, the way Home shows threads. */
export const Route = createFileRoute("/_home/pulls")({
  validateSearch: Search,
  component: Pulls,
});

function Pulls() {
  const search: PullsSearch = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <PullRequestsPage
      search={search}
      onSearch={(patch) =>
        void navigate({ search: (current) => ({ ...current, ...patch }), replace: true })
      }
    />
  );
}
