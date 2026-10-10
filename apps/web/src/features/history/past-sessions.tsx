import { lazy, Suspense, useState } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useProjectDirectory, type Project } from "@/lib/projects.ts";
import { SessionRow } from "./session-row.tsx";
import { useOpenSession, usePastSessions } from "./use-past-sessions.ts";

const AllSessions = lazy(() => import("./sessions-dialog.tsx"));

export function PastSessions(props: { projectId?: string | undefined }) {
  const directory = useProjectDirectory();
  const [selected, setSelected] = useState("");
  const project =
    directory.projects.find((entry) => entry.id === (props.projectId ?? selected)) ??
    (props.projectId ? undefined : directory.projects[0]);
  return (
    <>
      {props.projectId === undefined && project && (
        <Select
          label="Past sessions project"
          value={project.id}
          options={directory.projects.map((entry) => ({ value: entry.id, label: entry.name }))}
          onValueChange={setSelected}
        />
      )}
      {project && <ProjectSessions key={project.id} project={project} />}
    </>
  );
}

function ProjectSessions({ project }: { project: Project }) {
  const query = usePastSessions(project, { limit: 4 });
  const action = useOpenSession(project);
  const [all, setAll] = useState(false);
  const sessions =
    query.data?.sessions.filter((session) => session.support.status === "supported") ?? [];
  return (
    <section aria-label="Past sessions" className="mt-5 min-w-0">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">Past sessions</h3>
      {query.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Couldn't load past sessions.{" "}
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </p>
      ) : !query.data ? (
        <StatusLabel tone="working" label="Loading past sessions…" />
      ) : query.scanLabel ? (
        <StatusLabel tone="working" label={query.scanLabel} />
      ) : !sessions.length ? (
        <p className="text-sm text-muted-foreground">No past sessions in {project.name}.</p>
      ) : null}
      <ul aria-label={`Past sessions in ${project.name}`}>
        {sessions.slice(0, 4).map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            busy={action.busy}
            open={(entry, mode) => void action.open(entry, mode)}
          />
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => setAll(true)}
      >
        Show all past sessions
      </Button>
      {action.busy && <StatusLabel tone="working" label="Opening session…" />}
      {action.error && (
        <p role="alert" className="text-sm text-status-failed">
          {action.error}
        </p>
      )}
      {all && (
        <Suspense fallback={<StatusLabel tone="working" label="Loading past sessions…" />}>
          <AllSessions project={project} onClose={() => setAll(false)} />
        </Suspense>
      )}
    </section>
  );
}
