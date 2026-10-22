import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { IssuePage } from "@/features/forge-pages/index.ts";

/**
 * `/issues/ace/240`: one issue as a page. `repo` names a repository other than the project's own
 * (`github.com/acme/ace`); `back` is the list's address it was opened from.
 */
const Search = z.object({
  repo: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(512))), undefined),
  back: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
});

export const Route = createFileRoute("/_home/issues_/$project/$number")({
  validateSearch: Search,
  component: Issue,
});

function Issue() {
  const { project, number } = Route.useParams();
  const { back, repo } = Route.useSearch();
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return (
    <IssuePage
      key={`${project}:${repo ?? ""}#${parsed}`}
      project={project}
      number={parsed}
      repo={repo}
      back={back}
    />
  );
}
