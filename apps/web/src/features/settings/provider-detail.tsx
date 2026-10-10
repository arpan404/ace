import { compareVersions } from "@ace/ui-core/acp-registry";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense, useRef, useState } from "react";
import { ProviderTile } from "@/components/provider-tile.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { ProviderPreferences } from "./provider-configuration.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { ProviderSetupRow, type ProviderSetupActions } from "@/features/provider-setup/index.ts";
import { isMissing, useProviderEntries, type ProviderEntry } from "./provider-entries.ts";
import { RediscoverButton } from "./rediscover-button.tsx";
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

const DeferredProviderServices = deferredComponent(() =>
  import("./provider-services.tsx").then((module) => module.ProviderServices),
);

const DeferredProviderMcpServers = deferredComponent(() =>
  import("./provider-mcp-servers.tsx").then((module) => module.ProviderMcpServers),
);

const DeferredProviderAccounts = deferredComponent(() =>
  import("./provider-accounts.tsx").then((module) => module.ProviderAccounts),
);

const back = (
  <Link
    to="/settings/providers"
    aria-label="Back to Providers"
    className={buttonVariants({ size: "sm", variant: "ghost", className: "-mt-2 mb-3 -ml-2" })}
  >
    <CaretLeftIcon aria-hidden size={12} weight="bold" />
    Providers
  </Link>
);

/**
 * One provider's own page: who it's signed in as, the services it reaches (OpenCode, Pi), its
 * models, and technical facts tucked into Advanced. A problem or a missing sign-in
 * is the first thing on it, with the one button that fixes it.
 */
export function ProviderDetail(props: { id: string }) {
  const { entries, query } = useProviderEntries();
  const entry = entries?.find((candidate) => candidate.id === props.id);
  if (!entry)
    return (
      <SettingsBody
        page={query.isPending || query.isError ? "Providers" : "Provider not found"}
        back={back}
      >
        {query.isPending ? (
          <ListSkeleton label="provider" shape="row" rows={4} className="mt-7" />
        ) : (
          <p role="alert" className="mt-4 text-muted-foreground">
            {query.isError ? (
              <>
                Couldn't check providers. Try again. <RediscoverButton />
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

function ProviderPage(props: { entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  const [advanced, setAdvanced] = useState(false);
  const setupActions = useRef<ProviderSetupActions>(null);
  const missing = isMissing(props.entry);
  const upstreams = install.kind === "opencode" || install.kind === "pi";
  const version = row?.version ?? install.version;
  const updateAvailable =
    row?.updateAvailable ??
    (!!install.registry?.agent &&
      compareVersions(install.registry.agent.version, install.registry.version) > 0);
  const setup = (
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
      heading
      missing={missing}
      view={missing ? view : undefined}
      updateAvailable={updateAvailable}
    />
  );
  return (
    <SettingsBody
      page={install.name}
      back={back}
      icon={
        <ProviderTile
          provider={install.kind}
          acpAgentId={install.acpAgentId}
          size="lg"
          muted={missing}
        />
      }
      lede={
        <span className="text-sm">
          {version}
          {updateAvailable && (
            <span className="text-status-needs-you">
              {" "}
              ·{" "}
              {(row?.latestVersion ?? install.registry?.agent?.version)
                ? `${row?.latestVersion ?? install.registry?.agent?.version} available`
                : "Update available"}
            </span>
          )}
        </span>
      }
      titleActions={setup}
    >
      <div className="fx-view-in">
        {view?.detail && !view.ready && !missing && (
          <p className="mt-3 text-sm text-muted-foreground">{view.detail}</p>
        )}
        {!missing && (
          <>
            <Suspense fallback={null}>
              <DeferredProviderAccounts.Component
                provider={install.kind}
                acpAgentId={install.acpAgentId}
                name={install.name}
              />
            </Suspense>
          </>
        )}

        {!missing && (
          <>
            {upstreams && row && (
              <Suspense fallback={null}>
                <DeferredProviderServices.Component provider={install.kind} name={install.name} />
              </Suspense>
            )}
            <SettingSection label="Behaviour">
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
          </>
        )}
        <details
          className="mt-7 text-sm"
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
          {advanced && row && (
            <Suspense fallback={null}>
              <DeferredProviderMcpServers.Component provider={install.kind} name={install.name} />
            </Suspense>
          )}
          {advanced && <ProviderPreferences provider={install.kind} missing={missing} />}
          {advanced && !missing && install.kind !== "cursor" && install.kind !== "acp" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setupActions.current?.requestRemoval()}
            >
              Remove provider…
            </Button>
          )}
          {advanced && (
            <Suspense fallback={null}>
              <DeferredProviderTail.Component entry={props.entry} missing={missing} />
            </Suspense>
          )}
        </details>
      </div>
    </SettingsBody>
  );
}
