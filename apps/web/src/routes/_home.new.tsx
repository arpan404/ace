import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { NewThreadOnMachine } from "@/features/home/index.ts";
import { OpenFolderScreen } from "@/features/projects/index.ts";

/**
 * `/new?project=ace&base=main`: both optional; the page falls back to remembered choices.
 * `/new?folder=<absolute path>` (the desktop's `ace://open?folder=`) adds that folder as a
 * project, or finds it, and opens New thread in it.
 * `/new?machine=<hostId>&project=…` starts it on another of the person's machines (ADR 0100).
 */
const NewThreadSearch = z.object({
  discard: z.catch(z.optional(z.number().check(z.int(), z.gte(0))), undefined),
  skill: z.catch(
    z.optional(z.string().check(z.maxLength(64), z.regex(/^[a-z0-9][a-z0-9.-]*$/))),
    undefined,
  ),
  issue: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
  pullRequest: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
  project: z.catch(z.optional(z.string().check(z.minLength(1))), undefined),
  base: z.catch(z.optional(z.string().check(z.minLength(1))), undefined),
  machine: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
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
  const router = useRouter();
  // Boot may restore a recovered start, but a deliberate visit here (the sidebar, ⌘N) must stay.
  // Read before this route renders: the router resolves its location only after mounting it.
  const [recoverStart] = useState(() => router.state.resolvedLocation === undefined);
  if (search.folder) return <OpenFolderScreen key={search.folder} folder={search.folder} />;
  return (
    <NewThreadOnMachine
      recoverStart={recoverStart}
      machine={search.machine}
      key={`${search.machine ?? ""}:${search.project ?? ""}:${search.base ?? ""}:${search.skill ?? ""}:${search.discard ?? ""}:${search.pullRequest ?? ""}:${search.issue ?? ""}`}
      project={search.project}
      base={search.base}
      skill={search.skill}
      pullRequest={search.pullRequest}
      issue={search.issue}
    />
  );
}
