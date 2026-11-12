import { signInSteps, type ReadinessView } from "@ace/ui-core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import type { ProviderInstall } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";
import type { ProviderEntry } from "./provider-entries.ts";
import { SetupSteps } from "./acp-registry/setup-steps.tsx";

/*
 * The quiet end of a provider's page: the technical facts (where it's installed, how
 * it runs, how to sign in from a terminal), and removing an added agent.
 */

function Fact(props: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-(--setting-row-height-single) flex-wrap items-center gap-x-4 gap-y-1 py-2 text-ui">
      <dt className="w-36 shrink-0 text-muted-foreground">{props.term}</dt>
      <dd className="min-w-0 flex-1 text-right break-words">{props.children}</dd>
    </div>
  );
}

const mono = "font-mono text-sm";

export function ProviderAbout(props: {
  install: ProviderInstall;
  row: ProviderReadiness | undefined;
  view: ReadinessView | undefined;
}) {
  const { install, row, view } = props;
  const version = row?.version ?? install.version;
  const steps = signInSteps(install.kind);
  const entry = install.registry?.agent;
  return (
    <SettingSection label="About">
      <dl className="flex flex-col divide-y divide-border-soft">
        {/* The header already states a CLI's version; Cursor's names what it is (the SDK's). */}
        {version && install.kind === "cursor" && (
          <Fact term="SDK version">
            <span className={mono}>{version}</span>
          </Fact>
        )}
        {install.registry && <Fact term="Installed from">ACP registry</Fact>}
        {entry && (
          <Fact term="Set up">
            <SetupSteps name={install.name} loginHint={entry.loginHint} titled={false} />
          </Fact>
        )}
        <Fact term="Runs">
          {install.kind === "cursor" ? (
            "Cursor SDK, inside ace"
          ) : (
            <span className={mono}>{install.binary}</span>
          )}
        </Fact>
        {install.kind !== "cursor" && row?.path && (
          <Fact term="Location">
            <span className={`${mono} select-text`}>{row.path}</span>
          </Fact>
        )}
        {view?.unreported && (
          <Fact term="Sign-in">
            <span className="text-muted-foreground">
              Not reported by this CLI. ace counts it as ready while it lists models.
            </span>
          </Fact>
        )}
        {steps && (
          <Fact term="Terminal sign-in">
            {steps.prompt ? (
              <>
                Run <span className={mono}>{steps.run}</span>, then type{" "}
                <span className={mono}>{steps.prompt}</span>
              </>
            ) : (
              <>
                Run <span className={mono}>{steps.run}</span>
              </>
            )}
          </Fact>
        )}
      </dl>
    </SettingSection>
  );
}

/** An ACP agent added by command: take it off the list, then back to Providers. */
function useRemoveAgent(name: string) {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => backend.removeAcpAgent(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsQueries.providers(backend).queryKey,
      });
      void navigate({ to: "/settings/providers" });
    },
    onError: (error) =>
      toast.error({ title: `Couldn't remove ${name}`, description: error.message }),
  });
  return remove;
}

export function RemoveAgentMenuItem(props: { name: string }) {
  const remove = useRemoveAgent(props.name);
  return (
    <MenuItem disabled={remove.isPending} onClick={() => remove.mutate()}>
      Remove…
    </MenuItem>
  );
}

/** An added agent's removal, as a row of its page's Advanced group. */
export function RemoveAgentRow(props: { name: string }) {
  const remove = useRemoveAgent(props.name);
  return (
    <SettingRow title={`Remove ${props.name}`} inline>
      <Button
        size="sm"
        variant="ghost"
        tone="danger"
        aria-label={`Remove ${props.name}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        Remove
      </Button>
    </SettingRow>
  );
}

/** The provider's technical facts load after its status. */
export function ProviderTail(props: { entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  return <ProviderAbout install={install} row={row} view={view} />;
}
