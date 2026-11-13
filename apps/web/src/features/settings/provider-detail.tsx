import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReadinessView } from "@ace/ui-core";
import { Suspense, useRef } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { ProviderPreferences } from "./provider-configuration.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { ProviderSetupRow, type ProviderSetupActions } from "@/features/provider-setup/index.ts";
import {
  isMissing,
  updateAvailable,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";
import { ProviderProblemLine } from "./provider-problem-line.tsx";
import { SettingsBody } from "./settings-body.tsx";

/** The models section loads with the page, apart from the overview. */
const DeferredProviderModels = deferredComponent(() =>
  import("./provider-models.tsx").then((module) => module.ProviderModels),
);

const DeferredProviderTail = deferredComponent(() =>
  import("./provider-about.tsx").then((module) => module.ProviderTail),
);

const DeferredRemoveAgentMenuItem = deferredComponent(() =>
  import("./provider-about.tsx").then((module) => module.RemoveAgentMenuItem),
);

const DeferredRemoveAgentRow = deferredComponent(() =>
  import("./provider-about.tsx").then((module) => module.RemoveAgentRow),
);

const DeferredProviderServices = deferredComponent(() =>
  import("./provider-services.tsx").then((module) => module.ProviderServices),
);

const DeferredProviderMcpServers = deferredComponent(() =>
  import("./provider-mcp-servers.tsx").then((module) => module.ProviderMcpServers),
);

const DeferredProviderNativeTools = deferredComponent(() =>
  import("./provider-native-tools.tsx").then((module) => module.ProviderNativeTools),
);

const DeferredProviderAccounts = deferredComponent(() =>
  import("./provider-accounts.tsx").then((module) => module.ProviderAccounts),
);

const back = (
  <Link
    to="/settings/providers"
    aria-label="Back to Providers"
    className="inline-flex items-center gap-1 rounded-xs text-muted-foreground focus-ring hover:text-foreground"
  >
    <CaretLeftIcon aria-hidden size={12} />
    Providers
  </Link>
);

/**
 * One provider's own page: a problem or a missing sign-in first, with the one button that fixes
 * it; then its accounts, the services it reaches (OpenCode, Pi), its models, its own tools
 * (Codex computer use, Claude in Chrome), an Advanced group
 * (MCP servers, CLI path, turning it off, removing it) and its technical facts.
 */
export function ProviderDetail(props: { id: string }) {
  const { entries, query } = useProviderEntries();
  const entry = entries?.find(
    (candidate) =>
      candidate.id === props.id ||
      (candidate.install.kind === "acp" && `acp:${candidate.install.name}` === props.id),
  );
  if (!entry)
    return (
      <SettingsBody
        page={query.isPending || query.isError ? "Providers" : "Provider not found"}
        back={back}
      >
        {query.isPending ? (
          <ListSkeleton label="provider" shape="row" rows={4} className="mt-10" />
        ) : (
          <p role="alert" className="mt-4 text-muted-foreground">
            {query.isError ? (
              <>
                Couldn't check providers.{" "}
                <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
                  Retry
                </Button>
              </>
            ) : (
              "This provider isn't on this computer."
            )}
          </p>
        )}
      </SettingsBody>
    );
  return <ProviderPage entry={entry} />;
}

/**
 * Passed to the header's setup row so it carries only Update, install progress and the ⋯ menu:
 * signing in, reconnecting and turning on belong to the problem line under the header.
 */
const headerView = (view: ReadinessView | undefined): ReadinessView => ({
  state: "ready",
  ready: true,
  label: "",
  summary: "",
  tone: "ready",
  more: [],
  ...(view?.primary === "update" ? { primary: "update" } : {}),
});

function ProviderPage(props: { entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  const setupActions = useRef<ProviderSetupActions>(null);
  const missing = isMissing(props.entry);
  // Turned off in Settings: ace won't start it, sign in to it or list its models.
  const off = view?.state === "off";
  const usable = !missing && !off;
  const upstreams = install.kind === "opencode" || install.kind === "pi";
  const version = row?.version ?? install.version;
  const update = updateAvailable(props.entry);
  const latest = row?.latestVersion ?? install.registry?.agent?.version;
  const setup = (heading: boolean) => (
    <ProviderSetupRow
      ref={setupActions}
      provider={install.kind}
      acpAgentId={install.registry?.agent?.acpAgentId ?? install.acpAgentId}
      instance={install.instance}
      name={install.name}
      manage
      menuItems={
        install.added ? (
          <Suspense fallback={null}>
            <DeferredRemoveAgentMenuItem.Component name={install.name} />
          </Suspense>
        ) : undefined
      }
      heading={heading}
      missing={missing}
      view={missing ? view : headerView(view)}
      updateAvailable={update}
    />
  );
  return (
    <SettingsBody
      page={install.name}
      back={back}
      icon={
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-1">
          <ProviderIcon
            provider={install.kind}
            acpAgentId={install.acpAgentId}
            size={20}
            className={missing || off ? "opacity-60 grayscale" : undefined}
          />
        </span>
      }
      lede={
        (version || update) && (
          <span className="text-xs">
            {version && <span className="font-mono">{version}</span>}
            {update && (
              <span className="text-status-needs-you">
                {version ? " · " : ""}
                {latest ? `${latest} available` : "Update available"}
              </span>
            )}
          </span>
        )
      }
      // Installing lives in the problem line while the provider is missing.
      titleActions={missing ? undefined : setup(true)}
    >
      <div className="fx-view-in">
        <ProviderProblemLine
          provider={install.kind}
          acpAgentId={install.acpAgentId}
          instance={install.instance}
          name={install.name}
          missing={missing}
          view={view}
          install={setup(true)}
        />
        {usable && (
          <Suspense
            fallback={
              <SettingSection label="Accounts">
                <ListSkeleton label="accounts" shape="row" rows={3} />
              </SettingSection>
            }
          >
            <DeferredProviderAccounts.Component
              provider={install.kind}
              acpAgentId={install.acpAgentId}
              name={install.name}
            />
          </Suspense>
        )}
        {usable && upstreams && row && (
          <Suspense fallback={null}>
            <DeferredProviderServices.Component provider={install.kind} name={install.name} />
          </Suspense>
        )}
        {usable && (
          <SettingSection label="Models">
            <Suspense
              fallback={
                <div className="grid h-16 place-items-center">
                  <Spinner label="Loading models" />
                </div>
              }
            >
              <DeferredProviderModels.Component provider={install.kind} />
            </Suspense>
          </SettingSection>
        )}
        {usable && row?.nativeTools?.length ? (
          <Suspense fallback={null}>
            <DeferredProviderNativeTools.Component
              provider={install.kind}
              name={install.name}
              row={row}
            />
          </Suspense>
        ) : null}
        <SettingSection label="Advanced">
          {row && (
            <Suspense fallback={null}>
              <DeferredProviderMcpServers.Component provider={install.kind} name={install.name} />
            </Suspense>
          )}
          <ProviderPreferences
            provider={install.kind}
            name={install.name}
            missing={missing}
            off={off}
          />
          {!missing && install.kind !== "cursor" && install.kind !== "acp" && (
            <SettingRow title={`Remove ${install.name}'s CLI`} inline>
              <Button
                size="sm"
                variant="ghost"
                tone="danger"
                onClick={() => setupActions.current?.requestRemoval()}
              >
                Remove…
              </Button>
            </SettingRow>
          )}
          {install.added && (
            <Suspense fallback={null}>
              <DeferredRemoveAgentRow.Component name={install.name} />
            </Suspense>
          )}
        </SettingSection>
        {!missing && (
          <Suspense fallback={null}>
            <DeferredProviderTail.Component entry={props.entry} />
          </Suspense>
        )}
      </div>
    </SettingsBody>
  );
}
