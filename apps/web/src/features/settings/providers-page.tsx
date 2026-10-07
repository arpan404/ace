import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { ReadinessAction } from "@/features/sign-in/index.ts";
import { AddAcpAgent } from "./add-acp-agent.tsx";
import { RediscoverButton } from "./rediscover-button.tsx";
import {
  entryStatus,
  isMissing,
  useProviderEntries,
  type ProviderEntry,
} from "./provider-entries.ts";

/**
 * Settings → Providers: every coding agent on this computer as one calm row (its mark, its name,
 * one status line and at most the one action it needs), each opening its own page. Agents that
 * aren't installed and ACP agents sit in their own groups below.
 */
export function ProviderSettings() {
  const { entries, query } = useProviderEntries();
  if (query.isPending)
    return <ListSkeleton label="providers" shape="row" rows={5} className="mt-7" />;
  if (query.isError || !entries)
    return (
      <p role="alert" className="mt-7 text-sm text-muted-foreground">
        Couldn't list providers. {query.error?.message}
      </p>
    );
  const builtIn = entries.filter((entry) => entry.install.kind !== "acp");
  const installed = builtIn.filter((entry) => !isMissing(entry));
  const missing = builtIn.filter(isMissing);
  const agents = entries.filter((entry) => entry.install.kind === "acp");
  return (
    <>
      <SettingSection label="On this computer" card actions={<RediscoverButton />}>
        {installed.length ? (
          installed.map((entry) => <ProviderRow key={entry.id} entry={entry} />)
        ) : (
          <p className="px-4 py-5 text-muted-foreground">
            No coding agents found yet. Install one below, then check again.
          </p>
        )}
      </SettingSection>
      {missing.length > 0 && (
        <SettingSection label="Not installed" card>
          {missing.map((entry) => (
            <ProviderRow key={entry.id} entry={entry} />
          ))}
        </SettingSection>
      )}
      <SettingSection label="ACP agents" card>
        {agents.map((entry) => (
          <ProviderRow key={entry.id} entry={entry} />
        ))}
        <Row
          tile={
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-md border border-dashed text-lg text-subtle-foreground"
            >
              +
            </span>
          }
          title={<span className="font-medium">Add an agent</span>}
          status={
            <span className="text-muted-foreground">
              Any agent that speaks ACP, started by a command
            </span>
          }
          action={<AddAcpAgent />}
        />
      </SettingSection>
      <p className="mt-6 text-sm text-muted-foreground">
        Quota, limits and scheduling are in{" "}
        <Link to="/more/accounts" className="font-medium text-foreground hover:underline">
          Usage &amp; accounts ›
        </Link>
      </p>
    </>
  );
}

/** One row of a providers card: a tile, a name over a line of status, an action. */
function Row(props: { tile: ReactNode; title: ReactNode; status: ReactNode; action?: ReactNode }) {
  return (
    <div className="group relative flex min-h-16 items-center gap-3.5 px-4 py-3 transition-colors duration-(--dur-1) has-[a:hover]:bg-accent">
      {props.tile}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-ui">
        {props.title}
        <span className="text-sm text-muted-foreground">{props.status}</span>
      </div>
      {props.action && (
        <div className="relative z-10 flex shrink-0 items-center">{props.action}</div>
      )}
    </div>
  );
}

/** A provider: the whole row opens its page; its one action, if any, sits above that link. */
function ProviderRow(props: { entry: ProviderEntry }) {
  const { install, view } = props.entry;
  const name = install.name;
  const { tone, text, problem } = entryStatus(props.entry);
  // With no page open, a problem says what it is right in the list.
  const status = <StatusLine tone={tone} text={problem ? `${text} · ${problem}` : text} />;
  return (
    <Row
      tile={
        <ProviderTile
          provider={install.kind}
          acpAgentId={install.acpAgentId}
          muted={view?.state === "not_installed" || view?.state === "off"}
        />
      }
      title={
        <Link
          to="/settings/providers/$provider"
          params={{ provider: props.entry.id }}
          className="truncate font-medium text-foreground outline-none after:absolute after:inset-0 focus-visible:after:shadow-[inset_0_0_0_2px_var(--ring)]"
        >
          {name}
        </Link>
      }
      status={status}
      action={
        <>
          {view && (
            <ReadinessAction provider={install.kind} name={name} view={view} className="mr-1" />
          )}
          <CaretRightIcon
            aria-hidden
            size={14}
            className="pointer-events-none text-subtle-foreground transition-transform duration-(--dur-1) group-has-[a:hover]:translate-x-0.5 group-has-[a:hover]:text-foreground"
          />
        </>
      }
    />
  );
}
