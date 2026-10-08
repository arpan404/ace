import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { NewThreadPage } from "@/features/home/index.ts";
import { OpenFolderScreen } from "@/features/projects/index.ts";

/**
 * `/new?project=ace&base=main`: both optional; the page falls back to remembered choices.
 * `/new?folder=<absolute path>` (the desktop's `ace://open?folder=`) adds that folder as a
 * project, or finds it, and opens New thread in it.
 */
const NewThreadSearch = z.object({
  skill: z.catch(
    z.optional(z.string().check(z.maxLength(64), z.regex(/^[a-z0-9][a-z0-9.-]*$/))),
    undefined,
  ),
  project: z.catch(z.optional(z.string().check(z.minLength(1))), undefined),
  base: z.catch(z.optional(z.string().check(z.minLength(1))), undefined),
  folder: z.catch(
    z.optional(
      z.string().check(z.minLength(1), z.maxLength(4096), z.regex(/^(\/|[A-Za-z]:[\\/])/)),
    ),
    undefined,
  ),
});

/** ⌘N. The thread is created when the first message is sent. */
export const Route = createFileRoute("/_home/new")({
  validateSearch: NewThreadSearch,
  component: NewThreadRoute,
});

function NewThreadRoute() {
  const search = Route.useSearch();
  if (search.folder) return <OpenFolderScreen key={search.folder} folder={search.folder} />;
  return (
    <NewThreadPage
      key={`${search.project ?? ""}:${search.base ?? ""}:${search.skill ?? ""}`}
      project={search.project}
      base={search.base}
      skill={search.skill}
    />
  );
}
