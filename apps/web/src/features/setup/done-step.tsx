import { CheckCircleIcon, FolderSimpleIcon } from "@ace/icons";
import { displayPath, providerNames } from "@ace/ui-core";
import { Icon } from "@/components/icon.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useHostHome } from "@/features/projects/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { StepHeader } from "./step-header.tsx";
import type { useAgentCards } from "./use-agent-cards.ts";

/** What setup ended with: the project the first thread starts in and the agents ready for it. */
export function DoneStep(props: { projectId: string; agents: ReturnType<typeof useAgentCards> }) {
  const directory = useProjectDirectory();
  const home = useHostHome(usePrimaryMachine()).data?.path;
  const project = directory.projects.find((each) => each.id === props.projectId);
  const { ready } = props.agents;
  return (
    <>
      <StepHeader
        mark={<Icon icon={CheckCircleIcon} size={36} weight="fill" className="text-status-done" />}
        title="You're set up"
      />
      <dl className="grid w-full grid-cols-[auto_1fr] items-center gap-x-6 gap-y-4 text-sm">
        <dt className="text-muted-foreground">Project</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <Icon icon={FolderSimpleIcon} size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">
            {project?.name ?? directory.name(props.projectId)}
          </span>
          {project && (
            <span className="truncate font-mono text-muted-foreground">
              {displayPath(project.path, home)}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Agents</dt>
        <dd className="min-w-0">
          {ready.length ? (
            <ul aria-label="Ready agents" className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {ready.map(({ row }) => (
                <li key={row.provider} className="flex items-center gap-2">
                  <ProviderIcon provider={row.provider} size={16} />
                  {providerNames[row.provider]}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None ready yet</span>
          )}
        </dd>
      </dl>
    </>
  );
}
