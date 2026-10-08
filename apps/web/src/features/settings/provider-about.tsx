import { signInSteps, type ReadinessView } from "@ace/ui-core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { SignInButton } from "@/features/sign-in/index.ts";
import type { ProviderInstall } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";
import type { ProviderEntry } from "./provider-entries.ts";
import { SetupSteps } from "./acp-registry/setup-steps.tsx";

/*
 * The quiet end of a provider's page: the technical facts (version, where it's installed, how
 * it runs, how to sign in from a terminal), how to install it when it isn't, and Sign out.
 */

function Fact(props: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2 py-1">
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
      <dl className="divide-y">
        {version && (
          <Fact term={install.kind === "cursor" ? "SDK version" : "Version"}>
            <span className={mono}>{version}</span>
            {install.kind !== "cursor" && row?.updateAvailable && (
              <span className="ml-2 text-sm text-status-needs-you">Update available</span>
            )}
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

/** Sign out of a provider's CLI (it asks nothing first: signing in again is one click away). */
export function SignOutRow(props: { provider: ProviderInstall["kind"]; name: string }) {
  return (
    <DangerRow
      title={`Sign out of ${props.name}`}
      detail={`Signs ${props.name} out on the computer running ace, for every app that uses it.`}
    >
      <SignInButton variant="danger" target={{ provider: props.provider, action: "logout" }}>
        Sign out
      </SignInButton>
    </DangerRow>
  );
}

/** An ACP agent added by command: take it off the list, then back to Providers. */
export function RemoveAgentRow(props: { name: string }) {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => backend.removeAcpAgent(props.name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsQueries.providers(backend).queryKey,
      });
      toast.add({ title: `Removed ${props.name}` });
      void navigate({ to: "/settings/providers" });
    },
    onError: (error) =>
      toast.error({ title: `Couldn't remove ${props.name}`, description: error.message }),
  });
  return (
    <DangerRow title={`Remove ${props.name}`} detail="ace stops offering this agent.">
      <Button
        size="sm"
        variant="danger"
        aria-label={`Remove ${props.name}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        Remove
      </Button>
    </DangerRow>
  );
}

function DangerRow(props: { title: string; detail: string; children: ReactNode }) {
  return (
    <section aria-label={props.title} className="mt-7 flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-muted-foreground">{props.detail}</p>
      </div>
      {props.children}
    </section>
  );
}

/** The provider's technical facts and account-wide actions load after its status. */
export function ProviderTail(props: { entry: ProviderEntry; missing: boolean }) {
  const { install, row, view } = props.entry;
  return (
    <>
      {!props.missing && (
        <>
          <ProviderAbout install={install} row={row} view={view} />
          {row && view?.more.includes("sign_out") && (
            <SignOutRow provider={install.kind} name={install.name} />
          )}
        </>
      )}
      {install.added && <RemoveAgentRow name={install.name} />}
    </>
  );
}
