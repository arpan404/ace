import { createFileRoute, useNavigate, type SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";
import { IssueScreen } from "@/features/forge/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
const Search = z.object({
  project: z.catch(z.string().check(z.maxLength(256)), ""),
  repo: z.catch(
    z.string().check(z.regex(/^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/), z.maxLength(1024)),
    "",
  ),
  number: z.catch(z.optional(z.coerce.number().check(z.int(), z.gte(1))), undefined),
  state: z.catch(z.enum(["open", "closed"]), "open"),
  search: z.catch(z.string().check(z.maxLength(256)), ""),
  author: z.catch(z.string().check(z.regex(/^[\w-]*$/), z.maxLength(100)), ""),
  assignee: z.catch(z.string().check(z.regex(/^[\w-]*$/), z.maxLength(100)), ""),
  labels: z.catch(
    z.array(z.string().check(z.minLength(1), z.maxLength(100))).check(z.maxLength(20)),
    [],
  ),
  milestone: z.catch(z.string().check(z.maxLength(100)), ""),
  sort: z.catch(z.enum(["created", "updated", "comments"]), "updated"),
  order: z.catch(z.enum(["asc", "desc"]), "desc"),
  page: z.catch(z.coerce.number().check(z.int(), z.gte(1), z.lte(40)), 1),
});
export const Route = createFileRoute("/issues")({
  validateSearch: (search: SearchSchemaInput & Record<string, unknown>) => Search.parse(search),
  component: Issues,
});
function Issues() {
  const location = Route.useSearch();
  const navigate = useNavigate();
  return (
    <ViewFrame label="Issues" place="threads">
      <IssueScreen
        location={location}
        onLocation={(search) => void navigate({ to: "/issues", search: { ...search } })}
      />
    </ViewFrame>
  );
}
