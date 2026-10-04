import type { ProviderKind } from "@ace/protocol";
import { signInSteps } from "@ace/ui-core";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { providerStatusesKey } from "@/lib/provider-statuses.ts";
import { AddAcpAgent } from "./add-acp-agent.tsx";
import type { ProviderAccount, ProviderInstall } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

/**
 * "claude 2.1.4 · 2 accounts · 1 at limit", "codex · its own login", "Not installed",
 * "via ACP · 1 account".
 */
export function describeInstall(install: ProviderInstall): string {
  if (install.via && install.accounts.length === 0)
    return `${install.via} · runs ${install.binary}`;
  if (install.state === "not_installed")
    return `Not installed · ace looks for ${install.binary} on your PATH`;
  const signedIn = install.accounts.filter((account) => account.auth === "logged_in");
  const atLimit = install.accounts.filter((account) => account.availability === "exhausted");
  const parts = [install.via ?? [install.binary, install.version].filter(Boolean).join(" ")];
  // No ace account: the daemon runs the CLI on the person's own login.
  if (install.accounts.length === 0) parts.push("its own login");
  else if (signedIn.length === 0) parts.push("signed out");
  else if (install.accounts.length === 1 && !install.via) parts.push("signed in");
  else parts.push(`${signedIn.length} account${signedIn.length === 1 ? "" : "s"}`);
  if (atLimit.length) parts.push(`${atLimit.length} at limit`);
  return parts.join(" · ");
}

/** Installed provider CLIs from discovery, their logins, and the models each one offers. */
export function ProviderSettings() {
  const backend = useSettingsBackend();
  const providers = useQuery(settingsQueries.providers(backend));
  if (providers.isPending)
    return <ListSkeleton label="provider CLIs" shape="row" rows={5} className="mt-7" />;
  if (providers.isError)
    return (
      <p role="alert" className="mt-7 text-sm text-muted-foreground">
        Couldn't list provider CLIs. {providers.error.message}
      </p>
    );
  return (
    <section className="mt-7" aria-label="Providers">
      {providers.data.map((install) => (
        <ProviderRow key={`${install.kind}:${install.name}`} install={install} />
      ))}
      <SettingRow title="Any ACP agent" description="Add a command and ace will drive it.">
        <AddAcpAgent />
      </SettingRow>
    </section>
  );
}

export function RediscoverButton() {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const rediscover = useMutation({
    mutationFn: () => backend.rediscover(),
    onSuccess: (list) => {
      queryClient.setQueryData(settingsQueries.providers(backend).queryKey, list);
      void queryClient.invalidateQueries({ queryKey: providerStatusesKey });
    },
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => rediscover.mutate()}
      disabled={rediscover.isPending}
    >
      <ArrowClockwiseIcon aria-hidden size={14} />
      {rediscover.isPending ? "Checking…" : "Check again"}
    </Button>
  );
}

function ProviderRow(props: { install: ProviderInstall }) {
  const { install } = props;
  const [open, setOpen] = useState(false);
  const installed = install.state !== "not_installed";
  return (
    <>
      <SettingRow
        title={
          <span className="flex items-center gap-2">
            <ProviderIcon
              provider={install.kind}
              acpAgentId={install.acpAgentId}
              size={16}
              decorative
              className={installed ? undefined : "text-subtle-foreground"}
            />
            {install.name}
          </span>
        }
        description={describeInstall(install)}
      >
        {installed && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-label={`Manage ${install.name}`}
            onClick={() => setOpen(!open)}
          >
            Manage
          </Button>
        )}
      </SettingRow>
      {open && <ProviderDetail install={install} />}
    </>
  );
}

function accountState(account: ProviderAccount): string {
  if (account.auth === "logged_out") return "Signed out";
  if (account.availability === "exhausted") return "Limit reached";
  if (account.availability === "near_limit") return "Near limit";
  return "Signed in";
}

function Code(props: { text: string }) {
  return <code className="font-mono">{props.text}</code>;
}

/** The provider's own sign-in, run outside ace (`signInSteps`). */
function SignInHint(props: { install: ProviderInstall }) {
  const steps = signInSteps(props.install.kind);
  return (
    <p className="text-sm text-muted-foreground">
      {!steps ? (
        <>Sign in with {props.install.name}'s own setup, outside ace.</>
      ) : steps.prompt ? (
        <>
          Run <Code text={steps.run} /> in a terminal, then type <Code text={steps.prompt} />.
        </>
      ) : (
        <>
          Sign in with <Code text={steps.run} /> in a terminal.
        </>
      )}
    </p>
  );
}

function ProviderDetail(props: { install: ProviderInstall }) {
  const { install } = props;
  return (
    <div
      role="region"
      aria-label={`${install.name} details`}
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-8 pt-1 pb-4 pl-4"
    >
      <div>
        <h4 className="mb-1.5 text-[12px] font-medium text-subtle-foreground">Accounts</h4>
        {install.accounts.length === 0 && <SignInHint install={install} />}
        <ul className="flex flex-col gap-1">
          {install.accounts.map((account) => (
            <li key={account.id} className="flex items-baseline gap-2 text-ui">
              <span>{account.label}</span>
              {account.plan && <span className="text-muted-foreground">{account.plan}</span>}
              <span className="ml-auto text-sm text-subtle-foreground">
                {accountState(account)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-subtle-foreground">
          ace uses the CLI's own login and never stores credentials.
        </p>
      </div>
      <ProviderModels provider={install.kind} />
    </div>
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact" });

function ProviderModels(props: { provider: ProviderKind }) {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const query = settingsQueries.models(backend, props.provider);
  const models = useQuery(query);
  const refresh = useMutation({
    mutationFn: () => backend.refreshModels(props.provider),
    onSuccess: (list) => queryClient.setQueryData(query.queryKey, list),
  });
  return (
    <div>
      <div className="mb-1.5 flex items-center">
        <h4 className="text-[12px] font-medium text-subtle-foreground">Models</h4>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-5 px-1.5"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          Refresh models
        </Button>
      </div>
      {models.isPending && <Spinner aria-label="Loading models" />}
      {models.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">This CLI reported no models.</p>
      )}
      <ul aria-label="Models" className="flex flex-col gap-1">
        {models.data?.map((model) => (
          <li key={model.id} className="flex items-baseline gap-2 text-ui">
            <span>{model.displayName}</span>
            <span className="truncate font-mono text-[11.5px] text-subtle-foreground">
              {model.nativeModelId}
            </span>
            <span className="ml-auto shrink-0 text-sm text-subtle-foreground">
              {[
                model.isDefault ? "Default" : "",
                model.contextWindow ? `${compact.format(model.contextWindow)} context` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
