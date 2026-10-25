import type { ProviderKind, SkillEntry, WorkspaceId } from "@ace/protocol";
import { formatAgo, providerNames } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { AgentsMenu } from "./agents-menu.tsx";
import { homeLabel, skillAgents, timesText } from "./library-model.ts";
import { useSetSkillAgents, useSkillUsage } from "./library-source.ts";
import { AgentsLine } from "./skill-parts.tsx";
import { SkillSourceRow } from "./skill-update.tsx";
import { skillTitle } from "./skills-model.ts";

/** Who loads a skill, where it is saved, when agents use it, and how often it was used. */
export function SkillDetails(props: {
  entry: SkillEntry;
  workspaceId: WorkspaceId | undefined;
  project: string | undefined;
  /** Saving Runs: absent while the file is still being read. */
  onRunsChange: ((manual: boolean) => void) | undefined;
  runsPending: boolean;
  open: (() => void) | undefined;
}) {
  const { entry } = props;
  const editable = entry.editable;
  const providers = entry.agents.map((agent) => agent.provider);
  const copies = entry.agents.some((agent) => agent.via === "copy");
  return (
    <SettingSection label="Details">
      <SettingRow
        inline
        title="Agents"
        description={
          <AgentsLine
            providers={providers}
            extra={copies ? "each keeps its own copy" : undefined}
          />
        }
      >
        {editable && <ChangeAgents entry={entry} workspaceId={props.workspaceId} />}
      </SettingRow>
      <SettingRow
        inline
        title="Saved in"
        description={
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            {homeLabel(entry.scope, props.project)}
            {entry.scope !== "builtin" && (
              <span className="font-mono text-xs break-all text-subtle-foreground">
                {entry.path}
              </span>
            )}
          </span>
        }
      >
        {props.open && (
          <Button variant="secondary" size="sm" onClick={props.open}>
            Open in editor
          </Button>
        )}
      </SettingRow>
      <SettingRow
        inline
        title="Runs"
        description={
          entry.manual
            ? "Agents never load it by themselves"
            : "Agents load it by themselves when it fits"
        }
      >
        {editable && (
          <Select
            label="Runs"
            value={entry.manual ? "manual" : "auto"}
            disabled={!props.onRunsChange || props.runsPending}
            options={[
              { value: "auto", label: "When it fits" },
              { value: "manual", label: "Only when picked" },
            ]}
            onValueChange={(value) => props.onRunsChange?.(value === "manual")}
            className="w-44"
          />
        )}
      </SettingRow>
      {entry.argumentHint && (
        <SettingRow
          inline
          title="Arguments"
          description={<span className="font-mono text-xs">{entry.argumentHint}</span>}
        />
      )}
      {entry.source && <SkillSourceRow entry={entry} workspaceId={props.workspaceId} />}
      <UsedRow entry={entry} workspaceId={props.workspaceId} />
    </SettingSection>
  );
}

/** Agents' "Change": an agent that reads the skill's own folder, or keeps a copy, stays. */
function ChangeAgents(props: { entry: SkillEntry; workspaceId: WorkspaceId | undefined }) {
  const toast = useToast();
  const setAgents = useSetSkillAgents();
  const { entry } = props;
  const fixed = new Set(
    entry.agents.filter((agent) => !agent.removable).map((agent) => agent.provider),
  );
  return (
    <AgentsMenu
      agents={skillAgents}
      chosen={entry.agents.map((agent) => agent.provider)}
      locked={(provider) => fixed.has(provider)}
      disabled={setAgents.isPending}
      onCommit={(providers) =>
        setAgents.mutate(
          { id: entry.id, workspaceId: props.workspaceId, agents: providers.filter(isSkillAgent) },
          {
            onSuccess: (reply) => {
              // Agents the daemon had to leave in place were asked to go: say which.
              const kept = (reply.kept ?? []).filter((each) => !providers.includes(each.provider));
              if (kept.length)
                toast.info({
                  title: `${names(kept.map((each) => each.provider))} still ${kept.length === 1 ? "sees" : "see"} ${skillTitle(entry)}`,
                  description: "It reads the folder the skill is saved in.",
                });
            },
            onError: () =>
              toast.error({
                title: `Couldn't change who sees ${skillTitle(entry)}`,
                description: "Check your connection and try again.",
              }),
          },
        )
      }
    />
  );
}

const isSkillAgent = (provider: ProviderKind) => skillAgents.includes(provider);
const names = (providers: readonly ProviderKind[]) =>
  providers.map((provider) => providerNames[provider]).join(" and ");

/** "6 times · last in Release 0.9.4, 3d ago", or "Not used yet". */
function UsedRow(props: { entry: SkillEntry; workspaceId: WorkspaceId | undefined }) {
  const usage = useSkillUsage(props.entry.id, props.workspaceId);
  const now = useNow();
  const data = usage.data;
  const description = !usage.isSuccess ? (
    <Skeleton className="mt-1 w-40" />
  ) : !data?.count ? (
    "Not used yet"
  ) : (
    <span>
      {timesText(data.count)}
      {data.last && (
        <>
          {" · last in "}
          <Link
            to="/t/$threadId"
            params={{ threadId: data.last.threadId }}
            className="text-link hover:underline"
          >
            {data.last.title}
          </Link>
          {`, ${formatAgo(data.last.at, now)}`}
        </>
      )}
    </span>
  );
  return <SettingRow inline title="Used" description={description} />;
}
