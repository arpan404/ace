import { createFileRoute, useNavigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { InboxPage, type InboxSearch } from "@/features/forge-pages/index.ts";

const text = (max: number) =>
  z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(max))), undefined);

/** `/inbox?view=all&reason=mention&repo=github.com/acme/ace`: the inbox's filters, kept in the address. */
const Search = z.object({
  project: text(512),
  view: z.catch(z.optional(z.enum(["all"])), undefined),
  only: z.catch(z.optional(z.enum(["participating"])), undefined),
  reason: text(64),
  repo: text(512),
});

/** GitHub notifications beside the thread list, the way Home shows threads. */
export const Route = createFileRoute("/_home/inbox")({
  validateSearch: Search,
  component: Inbox,
});

function Inbox() {
  const search: InboxSearch = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <InboxPage
      search={search}
      onSearch={(patch) =>
        void navigate({ search: (current) => ({ ...current, ...patch }), replace: true })
      }
    />
  );
}
