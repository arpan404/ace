import { repositoryName } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { readDraft } from "@/features/thread/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useMachines, useScopedMachine } from "@/lib/machines.ts";
import { carriedText } from "./carried-draft.ts";
import { preparation, preparationKey } from "./preparations.ts";

/**
 * A project this machine doesn't have: one removed here, or one New thread brought from another
 * machine. Its saved work stays visible without granting another project its identity, and a
 * repository from another machine can be cloned here in one step.
 */
export function UnavailablePreparation(props: {
  host: string;
  project: string;
  /** The project's `origin` URL, when it came from another machine. */
  repo?: string | undefined;
  skill?: string | undefined;
  pullRequest?: string | undefined;
  issue?: string | undefined;
}) {
  const { storage } = useLayout();
  const navigate = useNavigate();
  const projects = useProjectDialogs();
  const machines = useMachines();
  const scoped = useScopedMachine();
  const machineSearch = useMachineSearch();
  const identity = useMachineIdentity();
  const here = scoped?.name ?? identity.name;
  const key = preparationKey(
    props.host,
    props.project,
    props.skill,
    props.issue ?? props.pullRequest,
  );
  const content = readDraft(storage, key) ?? preparation(storage, props.host, key)?.discardRecovery;
  // A message brought from another machine stays there until a project here takes it.
  const text = content?.text || carriedText(storage, props.host);
  const repo = props.repo ? repositoryName(props.repo) || props.repo : undefined;
  const machine = scoped?.id ?? machines.find((each) => each.primary)?.id;
  return (
    <Screen title="Project unavailable">
      <div className="px-5 py-6">
        <p role="alert" className="text-ui">
          {repo
            ? `${repo} isn't on ${here}. Clone it here to keep going, or start in another project.`
            : `This project isn't on ${here}. Add it here to keep going, or start in another project.`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {props.repo && machine ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() =>
                projects.open({
                  kind: "add",
                  tab: "clone",
                  clone: { url: props.repo ?? "", machine },
                })
              }
            >
              Clone {repo} here
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => projects.open({ kind: "add", tab: "sources" })}
            >
              Add a project
            </Button>
          )}
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
        {text && (
          <>
            <p className="mt-6 text-ui text-muted-foreground">
              {content ? "Your saved message, kept on this device:" : "Your message comes along:"}
            </p>
            <pre aria-label="Saved message" className="mt-2 whitespace-pre-wrap text-ui">
              {text}
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
