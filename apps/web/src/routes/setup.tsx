import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { SetupScreen } from "@/features/setup/index.ts";

/**
 * First-run setup, also opened from the palette. `?step=` is the step (Welcome when absent);
 * `?project=` is the project Done starts the first thread in.
 */
const SetupSearch = z.object({
  step: z.catch(z.optional(z.enum(["welcome", "agents", "project", "done"])), undefined),
  project: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
});

export const Route = createFileRoute("/setup")({
  validateSearch: SetupSearch,
  component: SetupRoute,
});

function SetupRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-reading">
      <SetupScreen
        step={search.step ?? "welcome"}
        project={search.project}
        onStep={(step, project) =>
          void navigate({ search: { step, ...(project ? { project } : {}) } })
        }
      />
    </div>
  );
}
