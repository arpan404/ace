import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { MissingState } from "@/components/ui/missing-state.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { readDraft } from "@/features/thread/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useScopedMachine } from "@/lib/machines.ts";
import { preparation, preparationKey } from "./preparations.ts";

/** Keep a removed project's saved work visible without granting another project its identity. */
export function UnavailablePreparation(props: {
  host: string;
  project: string;
  skill?: string | undefined;
  pullRequest?: string | undefined;
  issue?: string | undefined;
}) {
  const { storage } = useLayout();
  const navigate = useNavigate();
  const projects = useProjectDialogs();
  const machineSearch = useMachineSearch();
  const scoped = useScopedMachine();
  const identity = useMachineIdentity();
  const here = scoped?.name ?? identity.name;
  const key = preparationKey(
    props.host,
    props.project,
    props.skill,
    props.issue ?? props.pullRequest,
  );
  const content = readDraft(storage, key) ?? preparation(storage, props.host, key)?.discardRecovery;
  const kept = !!content?.text || !!content?.attachments.length;
  return (
    <Screen title="">
      <div role="alert" className="h-full">
        <MissingState
          title={`This project isn't on ${here}`}
          description="It may have been removed, or it lives on another computer. Add it here to keep going, or start in another project."
          actions={
            <>
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => projects.open({ kind: "add", tab: "sources" })}
              >
                Add a project
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/new",
                    search: {
                      ...machineSearch,
                      skill: props.skill,
                      pullRequest: props.pullRequest,
                      issue: props.issue,
                    },
                  })
                }
              >
                Choose another project
              </Button>
            </>
          }
        >
          {kept && (
            <>
              <p className="text-sm text-muted-foreground">
                Your saved message, kept on this device
              </p>
              {content?.text && (
                <pre
                  aria-label="Saved message"
                  className="mt-2 max-h-72 overflow-y-auto border-l-2 border-border pl-3 text-left font-sans text-ui leading-normal whitespace-pre-wrap text-foreground"
                >
                  {content.text}
                </pre>
              )}
              {!!content?.attachments.length && (
                <ul
                  aria-label="Saved attachments"
                  className="mt-2 space-y-0.5 pl-3.5 text-left text-sm text-muted-foreground"
                >
                  {content.attachments.map((file) => (
                    <li key={`${file.sha256}:${file.name}`} className="truncate">
                      {file.name}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </MissingState>
      </div>
    </Screen>
  );
}
