import { createFileRoute, useNavigate, type SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";
import { PrScreen } from "@/features/forge/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
const Search = z.object({
  project: z.catch(z.string().check(z.maxLength(256)), ""),
  repo: z.catch(
    z.string().check(z.regex(/^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/), z.maxLength(1024)),
    "",
  ),
  number: z.catch(z.optional(z.coerce.number().check(z.int(), z.minimum(1))), undefined),
  tab: z.catch(z.enum(["conversation", "commits", "checks", "files"]), "conversation"),
  state: z.catch(z.enum(["open", "draft", "closed", "merged"]), "open"),
  search: z.catch(z.string().check(z.maxLength(256)), ""),
  author: z.catch(z.string().check(z.regex(/^[\w-]*$/), z.maxLength(100)), ""),
  reviewer: z.catch(z.string().check(z.regex(/^[\w-]*$/), z.maxLength(100)), ""),
  sort: z.catch(z.enum(["created", "updated", "comments"]), "updated"),
  order: z.catch(z.enum(["asc", "desc"]), "desc"),
  page: z.catch(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(40)), 1),
});
export const Route = createFileRoute("/pull-requests")({
  validateSearch: (search: SearchSchemaInput & Record<string, unknown>) => Search.parse(search),
  component: PullRequests,
});
function PullRequests() {
  const location = Route.useSearch();
  const navigate = useNavigate();
  return (
    <ViewFrame label="Pull requests" place="threads">
      <PrScreen
        location={location}
        onLocation={(search) => void navigate({ to: "/pull-requests", search: { ...search } })}
      />
    </ViewFrame>
  );
}
