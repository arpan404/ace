import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
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
  return (
    <Screen title="Project unavailable">
      <div className="px-5 py-6">
        <p role="alert" className="text-ui">
          This project isn&apos;t on {here}. Add it here to keep going, or start in another project.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
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
            variant="secondary"
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
        </div>
        {content?.text && (
          <>
            <p className="mt-6 text-ui text-muted-foreground">
              Your saved message, kept on this device:
            </p>
            <pre aria-label="Saved message" className="mt-2 whitespace-pre-wrap text-ui">
              {content.text}
            </pre>
          </>
        )}
        {!!content?.attachments.length && (
          <ul aria-label="Saved attachments" className="mt-3 text-ui">
            {content.attachments.map((file) => (
              <li key={`${file.sha256}:${file.name}`}>{file.name}</li>
            ))}
          </ul>
        )}
      </div>
    </Screen>
  );
}
