import { CaretLeftIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense, type ReactNode } from "react";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { ProviderUsage } from "@/features/accounts/index.ts";
import { ReadinessAction } from "@/features/sign-in/index.ts";
import { ProviderAccounts } from "./provider-accounts.tsx";
import { InstallSteps, ProviderAbout, RemoveAgentRow, SignOutRow } from "./provider-about.tsx";
import {
  entryStatus,
  isMissing,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";
import { ProviderServices } from "./provider-services.tsx";
import { SettingsBody } from "./settings-body.tsx";

/** The models section loads with the page, apart from the overview. */
const DeferredProviderModels = deferredComponent(() =>
  import("./provider-models.tsx").then((module) => module.ProviderModels),
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
      <SettingsBody page="Providers" back={back}>
        {query.isPending ? (
          <ListSkeleton label="provider" shape="row" rows={4} className="mt-7" />
        ) : (
          <p role="alert" className="mt-4 text-muted-foreground">
            {query.isError
              ? `Couldn't list providers. ${query.error.message}`
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
          <Callout
            tone={view.tone === "problem" ? "problem" : "action"}
            title={view.tone === "problem" ? "Needs attention" : `Sign in to use ${install.name}`}
            detail={view.detail ?? `${install.name} isn't signed in on this computer yet.`}
            action={<ReadinessAction provider={install.kind} name={install.name} view={view} />}
          />
        )}
        {missing ? (
          <InstallSteps install={install} row={row} />
        ) : (
          <>
            {upstreams && row && <ProviderServices provider={install.kind} name={install.name} />}
            {install.kind !== "acp" && (
              <ProviderAccounts provider={install.kind} name={install.name} view={view} />
            )}
            <SettingSection label="Usage" card>
              <ProviderUsage provider={install.kind} />
            </SettingSection>
            <SettingSection label="Models" card>
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
            <ProviderAbout install={install} row={row} view={view} />
            {row && view?.more.includes("sign_out") && (
              <SignOutRow provider={install.kind} name={install.name} />
            )}
          </>
        )}
        {install.added && <RemoveAgentRow name={install.name} />}
      </div>
    </SettingsBody>
  );
}

/** The one thing to fix, first on the page: what's wrong in a line, and its button. */
function Callout(props: {
  tone: "problem" | "action";
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div
      role={props.tone === "problem" ? "alert" : "status"}
      data-tone={props.tone === "problem" ? "failed" : "needs-you"}
      className={cn(
        "mt-7 flex items-center gap-3 rounded-card bg-(--tone)/12 px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--border)]",
      )}
    >
      <WarningCircleIcon aria-hidden size={20} className="shrink-0 text-(--tone)" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-muted-foreground">{props.detail}</p>
      </div>
      {props.action}
    </div>
  );
}
