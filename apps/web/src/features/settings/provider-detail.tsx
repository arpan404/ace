import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { ProviderPreferences } from "./provider-configuration.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { ReadinessAction } from "@/features/sign-in/index.ts";
import {
  entryStatus,
  isMissing,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";
import { SettingsBody } from "./settings-body.tsx";

/** The models section loads with the page, apart from the overview. */
const DeferredProviderModels = deferredComponent(() =>
  import("./provider-models.tsx").then((module) => module.ProviderModels),
);

const DeferredProviderTail = deferredComponent(() =>
  import("./provider-about.tsx").then((module) => module.ProviderTail),
);

const DeferredProviderUsage = deferredComponent(() =>
  import("@/features/accounts/index.ts").then((module) => module.ProviderUsage),
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

const DeferredProviderCli = deferredComponent(() =>
  import("./provider-cli.tsx").then((module) => module.ProviderCli),
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
 * models, and the technical facts and Sign out tucked at the end. A problem or a missing sign-in
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
            {query.isError
              ? "Couldn't list providers. Reconnect and check again."
              : "This provider isn't on this computer."}
          </p>
        )}
      </SettingsBody>
    );
  return <ProviderPage entry={entry} />;
}

function ProviderPage(props: { entry: ProviderEntry }) {
  const { install, row, view } = props.entry;
  const missing = isMissing(props.entry);
  const upstreams = install.kind === "opencode" || install.kind === "pi";
  const { tone, text } = entryStatus(props.entry);
  const status = <StatusLine tone={tone} text={text} className="text-ui" />;
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
      lede={status}
    >
      <div className="fx-view-in">
        {view?.primary && row && (
          <div
            role={view.tone === "problem" ? "alert" : "status"}
            className="mt-4 flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="min-w-0 flex-1 text-muted-foreground">
              {view.detail ?? `Sign in to use ${install.name}.`}
            </span>
            <ReadinessAction provider={install.kind} name={install.name} view={view} />
          </div>
        )}
        <ProviderPreferences provider={install.kind} missing={missing} />
        {install.kind !== "cursor" && (
          <Suspense fallback={null}>
            <DeferredProviderCli.Component
              key={props.entry.id}
              install={install}
              missing={missing}
            />
          </Suspense>
        )}
        {!missing && (
          <>
            {upstreams && row && (
              <Suspense fallback={null}>
                <DeferredProviderServices.Component provider={install.kind} name={install.name} />
              </Suspense>
            )}
            <Suspense fallback={null}>
              <DeferredProviderAccounts.Component
                provider={install.kind}
                acpAgentId={install.acpAgentId}
                name={install.name}
              />
            </Suspense>
            <SettingSection label="Usage">
              <Suspense fallback={null}>
                <DeferredProviderUsage.Component
                  provider={install.kind}
                  acpAgentId={install.acpAgentId}
                />
              </Suspense>
            </SettingSection>
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
            {row && (
              <Suspense fallback={null}>
                <DeferredProviderMcpServers.Component provider={install.kind} name={install.name} />
              </Suspense>
            )}
          </>
        )}
        <Suspense fallback={null}>
          <DeferredProviderTail.Component entry={props.entry} missing={missing} />
        </Suspense>
      </div>
    </SettingsBody>
  );
}
