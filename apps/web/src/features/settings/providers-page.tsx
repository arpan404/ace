import { readinessView, signInSteps, type CatalogSignal, type ReadinessView } from "@ace/ui-core";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import {
  onboardingKey,
  useProviderReadiness,
  type ProviderReadiness,
} from "@/lib/provider-readiness.ts";
import { ManageMenu, ReadinessActions } from "@/features/sign-in/index.ts";
import { useCatalogSignals } from "@/lib/provider-signals.ts";
import { AddAcpAgent } from "./add-acp-agent.tsx";
import { UpstreamSources } from "./upstream-sources.tsx";
import type { ProviderAccount, ProviderInstall } from "./data/backend.ts";
import { settingsQueries, useSettingsBackend } from "./data/use-settings.ts";

/**
 * "claude 2.1.4 · 2 accounts · 1 at limit", "codex · its own login", "Not installed",
 * "via ACP · 1 account".
 */
export function describeInstall(install: ProviderInstall, ready?: boolean): string {
  if (install.via && install.accounts.length === 0)
    return `${install.via} · runs ${install.binary}`;
  if (install.kind === "cursor" && install.state === "not_installed")
    return "Cursor SDK is unavailable";
  if (install.state === "not_installed")
    return `Not installed · ace looks for ${install.binary} on your PATH`;
  const unknown = install.accounts.filter((account) => account.auth === "unknown");
  const atLimit = install.accounts.filter((account) => account.availability === "exhausted");
  const parts = [install.via ?? [install.binary, install.version].filter(Boolean).join(" ")];
  // No ace account: the daemon runs the CLI on the person's own login. Where readiness (`ready`)
  // says otherwise, the accounts' word is left out rather than contradict it.
  if (install.state === "unknown") parts.push("sign-in unknown");
  else if (install.state === "signed_out") {
    if (ready !== true) parts.push("signed out");
  } else if (install.accounts.length === 0 || (install.accounts.length === 1 && !install.via)) {
    if (ready !== false) parts.push("signed in");
  } else
    parts.push(`${install.accounts.length} account${install.accounts.length === 1 ? "" : "s"}`);
  if (unknown.length && install.state !== "unknown")
    parts.push(`${unknown.length} sign-in unknown`);
  if (atLimit.length) parts.push(`${atLimit.length} at limit`);
  return parts.join(" · ");
}

/** Installed provider CLIs from discovery, their logins, and the models each one offers. */
export function ProviderSettings() {
  const backend = useSettingsBackend();
  const providers = useQuery(settingsQueries.providers(backend));
  // Each CLI's own login (signed in as whom, or what it needs), live as sign-ins finish.
  const readiness = useProviderReadiness();
  const signals = useCatalogSignals();
  if (providers.isPending)
    return <ListSkeleton label="providers" shape="row" rows={5} className="mt-7" />;
  if (providers.isError)
    return (
      <p role="alert" className="mt-7 text-sm text-muted-foreground">
        Couldn't list providers. {providers.error.message}
      </p>
    );
  return (
    <SettingSection
      label="Providers"
      card
      actions={
        <>
          <Link to="/setup" className={buttonVariants({ size: "sm", variant: "ghost" })}>
            Set up providers
          </Link>
          <RediscoverButton />
        </>
      }
    >
      {providers.data.map((install) => (
        <ProviderRow
          key={`${install.kind}:${install.name}`}
          install={install}
          readiness={
            install.kind === "acp"
              ? undefined
              : readiness.data?.find((row) => row.provider === install.kind)
          }
          catalog={signals(install.kind)}
        />
      ))}
      <SettingRow title="Any ACP agent" description="Add a command and ace will drive it." inline>
        <AddAcpAgent />
      </SettingRow>
    </SettingSection>
  );
}

export function RediscoverButton() {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const rediscover = useMutation({
    mutationFn: () => backend.rediscover(),
    onSuccess: (list) => {
      queryClient.setQueryData(settingsQueries.providers(backend).queryKey, list);
      // Readiness and the pickers' statuses (both under "providers"), and setup's checklist.
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: onboardingKey });
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

function ProviderRow(props: {
  install: ProviderInstall;
  readiness: ProviderReadiness | undefined;
  catalog: CatalogSignal | undefined;
}) {
  const { install, readiness } = props;
  const [open, setOpen] = useState(false);
  const installed = install.state !== "not_installed";
  const view = readiness && readinessView(readiness, props.catalog);
  // Accounts and models, from the row's one Manage menu.
  const details = { label: open ? "Hide details" : "Show details", onSelect: () => setOpen(!open) };
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
        description={
          <>
            <span>{describeInstall(install, view?.ready)}</span>
            {readiness && view && (
              <ReadinessLine
                row={readiness}
                view={view}
                saysUnknown={install.state === "unknown"}
              />
            )}
          </>
        }
      >
        {install.added && <RemoveAgent name={install.name} />}
        {readiness && view ? (
          <ReadinessActions
            provider={readiness.provider}
            name={install.name}
            view={view}
            extra={installed ? [details] : []}
          />
        ) : (
          installed && <ManageMenu label={`Manage ${install.name}`} items={[details]} />
        )}
      </SettingRow>
      {installed && readiness && (install.kind === "opencode" || install.kind === "pi") && (
        <UpstreamSources provider={install.kind} name={install.name} />
      )}
      {open && <ProviderDetail install={install} />}
    </>
  );
}

/**
 * What the CLI's own login says, where it adds to the accounts line: who is signed in, what
 * needs attention, or the command that installs it. A CLI that doesn't report its sign-in is
 * said so once, quietly.
 */
function ReadinessLine(props: {
  row: ProviderReadiness;
  view: ReadinessView;
  saysUnknown: boolean;
}) {
  const { row, view } = props;
  if (view.state === "not_installed")
    return row.installCommand ? (
      <span className="mt-1 block">
        Install with <CopyCommand command={row.installCommand} />
      </span>
    ) : view.detail ? (
      <span className="block">{view.detail}</span>
    ) : null;
  // OpenCode and Pi: how many upstreams are connected, or that none is.
  if (view.upstreams)
    return <span className="block">{[view.label, view.detail].filter(Boolean).join(" · ")}</span>;
  const unreported =
    row.auth === "unknown" && (view.state === "ready" || view.state === "unconfirmed");
  if (unreported)
    return props.saysUnknown ? null : (
      <span className="block text-subtle-foreground">Sign-in not reported by this CLI</span>
    );
  if (view.state === "ready" && !row.accountLabel) return null;
  return <span className="block">{[view.label, view.detail].filter(Boolean).join(" · ")}</span>;
}

function accountState(account: ProviderAccount): string {
  if (account.auth === "logged_out") return "Signed out";
  if (account.auth === "unknown") return "Sign-in unknown";
  if (account.availability === "exhausted") return "Limit reached";
  if (account.availability === "near_limit") return "Near limit";
  return "Signed in";
}

function Code(props: { text: string }) {
  return <code className="font-mono">{props.text}</code>;
}

/** The provider's own sign-in, run outside ace (`signInSteps`). */
function SignInHint(props: { install: ProviderInstall }) {
  if (props.install.kind === "cursor")
    return (
      <p className="text-sm text-muted-foreground">Sign in to Cursor using its browser sign-in.</p>
    );
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
          ace uses the provider's own login and never stores credentials.
        </p>
      </div>
      <Suspense fallback={<Spinner label="Loading models" />}>
        <DeferredProviderModels.Component provider={install.kind} />
      </Suspense>
    </div>
  );
}

/** The models section loads with the provider's details, apart from the Settings pages. */
const DeferredProviderModels = deferredComponent(() =>
  import("./provider-models.tsx").then((module) => module.ProviderModels),
);

/** An ACP agent added by command: take it off the list. */
function RemoveAgent(props: { name: string }) {
  const backend = useSettingsBackend();
  const queryClient = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => backend.removeAcpAgent(props.name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsQueries.providers(backend).queryKey,
      });
      toast.add({ title: `Removed ${props.name}` });
    },
    onError: (error) =>
      toast.error({ title: `Couldn't remove ${props.name}`, description: error.message }),
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Remove ${props.name}`}
      disabled={remove.isPending}
      onClick={() => remove.mutate()}
    >
      Remove
    </Button>
  );
}
