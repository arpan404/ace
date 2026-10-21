import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { IssuesPage, type IssuesSearch } from "@/features/forge-pages/index.ts";

const text = (max: number) =>
  z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(max))), undefined);
const choice = <T extends string>(values: readonly [T, ...T[]]) =>
  z.catch(z.optional(z.enum(values)), undefined);

/** `/issues?state=closed&who=assigned&issue=240`: the filters, search and the open issue. */
const Search = z.object({
  project: text(512),
  who: choice(["all", "assigned", "created"]),
  state: choice(["open", "closed"]),
  sort: choice(["updated", "created", "comments"]),
  author: text(100),
  labels: z.catch(
    z.optional(z.array(z.string().check(z.maxLength(100))).check(z.maxLength(20))),
    undefined,
  ),
  q: text(256),
  issue: z.catch(z.optional(z.number().check(z.int(), z.positive())), undefined),
});

/** Issues beside the thread list, the way Home shows threads. */
export const Route = createFileRoute("/_home/issues")({
  validateSearch: Search,
  component: Issues,
});

function Issues() {
  const search: IssuesSearch = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <IssuesPage
      search={search}
      onSearch={(patch) =>
        void navigate({ search: (current) => ({ ...current, ...patch }), replace: true })
      }
    />
  );
}
