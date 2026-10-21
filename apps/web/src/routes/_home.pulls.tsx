import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { PullRequestsPage, type PullsSearch } from "@/features/forge-pages/index.ts";

const text = (max: number) =>
  z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(max))), undefined);
const choice = <T extends string>(values: readonly [T, ...T[]]) =>
  z.catch(z.optional(z.enum(values)), undefined);

/**
 * `/pulls?state=merged&who=reviewing&labels=["bug"]`: every filter, the sort and the search, so a
 * link, a reload or coming back from a pull request shows the same list.
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
