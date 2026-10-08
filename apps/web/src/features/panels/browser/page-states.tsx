import {
  ArrowClockwiseIcon,
  BrowserIcon,
  ClockCounterClockwiseIcon,
  GlobeSimpleIcon,
  PlayIcon,
  WarningCircleIcon,
  WifiSlashIcon,
} from "@phosphor-icons/react";
import {
  addressHost,
  displayAddress,
  type AddressSuggestion,
  type BrowserFailure,
} from "@ace/ui-core";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { BrowserDownload } from "../sources.ts";

const downloadPhases: Record<BrowserDownload["phase"], string> = {
  downloading: "Downloading the browser",
  verifying: "Checking the download",
  extracting: "Unpacking the browser",
};

/** "Downloading the browser · 40%": the daemon fetches Chromium before its first browser. */
export function downloadText(download: BrowserDownload): string {
  const phase = downloadPhases[download.phase];
  return download.phase === "downloading" && download.fraction !== undefined
    ? `${phase} · ${Math.floor(download.fraction * 100)}%`
    : `${phase}…`;
}

/**
 * The daemon fetching Chromium: a thin bar, determinate while it knows the size, sweeping while
 * it checks and unpacks.
 */
function DownloadBar(props: { download: BrowserDownload }) {
  const { download } = props;
  const percent =
    download.phase === "downloading" && download.fraction !== undefined
      ? Math.floor(Math.min(1, Math.max(0, download.fraction)) * 100)
      : undefined;
  return (
    <span className="flex w-[220px] flex-col items-center gap-1.5">
      <span
        role="progressbar"
        aria-label={downloadPhases[download.phase]}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={downloadText(download)}
        className="relative block h-1 w-full overflow-hidden rounded-full bg-secondary"
      >
        {percent === undefined ? (
          <span className="fx-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-foreground/70" />
        ) : (
          <span
            className="absolute inset-0 origin-left rounded-full bg-foreground/70 transition-transform duration-(--dur-2) ease-smooth"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        )}
      </span>
      <span className="text-xs text-subtle-foreground tabular-nums">{downloadText(download)}</span>
    </span>
  );
}

/** The first browser on this machine: Chromium downloads before the page can open. */
export function Opening(props: { download: BrowserDownload | undefined }) {
  if (props.download)
    return (
      <EmptyState
        icon={BrowserIcon}
        title="Getting the browser ready"
        description={
          <span className="flex flex-col items-center gap-3">
            <DownloadBar download={props.download} />
            <span>The first browser on this machine takes a few minutes.</span>
          </span>
        }
      />
    );
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center gap-2 text-ui text-muted-foreground"
    >
      <Spinner />
      Opening the page…
    </div>
  );
}

/**
 * A new browser tab: where to go. Addresses this thread runs (its dev servers) and visited come
 * first, as a grid of quiet tiles; the address bar above takes anything else.
 */
export function StartPage(props: {
  suggestions: readonly AddressSuggestion[];
  disabled?: string | undefined;
  onGo(url: string): void;
}) {
  return (
    <div className="@container mx-auto flex w-full max-w-[640px] flex-col px-6 pt-14 pb-10">
      <h2 className="text-md font-medium text-foreground">Open a page</h2>
      <p className="mt-1 text-ui leading-normal text-muted-foreground">
        Type an address above. This thread's agents use the same page, so you can watch them or take
        over.
      </p>
      {props.suggestions.length > 0 && (
        <section aria-labelledby="browser-suggested" className="mt-8">
          <h3 id="browser-suggested" className="text-xs font-medium text-subtle-foreground">
            Suggested
          </h3>
          <ul
            aria-label="Suggested pages"
            className="mt-2 grid grid-cols-2 gap-2 @min-[36rem]:grid-cols-4"
          >
            {props.suggestions.map((suggestion) => (
              <li key={suggestion.url} className="min-w-0">
                <button
                  type="button"
                  disabled={props.disabled !== undefined}
                  title={props.disabled ?? displayAddress(suggestion.url)}
                  onClick={() => props.onGo(suggestion.url)}
                  className="flex h-[92px] w-full min-w-0 flex-col items-center justify-center gap-2 rounded-lg px-3 text-center outline-none transition-colors duration-(--dur-1) bg-foreground/3 hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)] disabled:opacity-50"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-foreground/5">
                    <Icon
                      icon={suggestion.detail === "Visited" ? ClockCounterClockwiseIcon : PlayIcon}
                      size={14}
                      className="text-muted-foreground"
                    />
                  </span>
                  <span className="w-full truncate text-ui text-foreground">
                    {suggestion.label}
                  </span>
                  <span className="-mt-1.5 w-full truncate text-xs text-subtle-foreground">
                    {suggestion.detail}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A page that failed: its address stays, what happened is said plainly, and Reload is there. */
export function LoadFailed(props: {
  url: string;
  failure: BrowserFailure;
  onReload(): void;
  extra?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-[520px] flex-col items-start px-8 pt-20 pb-10"
    >
      <Icon icon={WarningCircleIcon} size={36} empty className="mb-4 text-muted-foreground" />
      <h2 className="text-md font-medium text-foreground">{props.failure.title}</h2>
      <p className="mt-1 text-ui text-muted-foreground">{addressHost(props.url) ?? props.url}</p>
      <p className="mt-3 text-ui leading-normal text-muted-foreground">{props.failure.detail}</p>
      <div className="mt-6 flex gap-2">
        <Button size="sm" onClick={props.onReload}>
          <ArrowClockwiseIcon aria-hidden size={14} />
          {props.failure.needsControl ? "Take control and reload" : "Reload"}
        </Button>
        {props.extra}
      </div>
    </div>
  );
}

/**
 * This tab's page is open, but another of the thread's pages is the live one (the one the agent
 * works in). Showing it here makes it the live page, taking control from an agent if one drives.
 */
export function Background(props: {
  url: string;
  agent: boolean;
  disabled?: string | undefined;
  onShow(): void;
}) {
  const address = displayAddress(props.url) || "A blank page";
  return (
    <EmptyState
      icon={GlobeSimpleIcon}
      title={addressHost(props.url) ?? address}
      description={
        props.agent
          ? `An agent is using another page of this thread. Show ${address} to take over and switch to it.`
          : `${address} is open in the background.`
      }
      action={
        <Button
          size="sm"
          disabled={props.disabled !== undefined}
          title={props.disabled}
          onClick={props.onShow}
        >
          Show this page
        </Button>
      }
    />
  );
}

/**
 * A tab kept from before (a restart, or the thread's page was closed) whose page isn't open
 * now: its address, its title and this card all name the same page, which opens again in one
 * click. Nothing opens by itself, since opening starts a browser.
 */
export function Reopen(props: {
  url: string;
  /** Where the thread's live page is now, when it has one this tab isn't showing. */
  liveUrl?: string | undefined;
  disabled?: string | undefined;
  onReopen(): void;
}) {
  const address = displayAddress(props.url) || props.url;
  return (
    <EmptyState
      icon={GlobeSimpleIcon}
      title={addressHost(props.url) ?? address}
      description={
        props.liveUrl === undefined
          ? `This page isn't open right now. Open ${address} again to pick up where this tab left off.`
          : `This thread's page is showing ${displayAddress(props.liveUrl) || "a blank page"}. Load ${address} here to bring it back to this tab.`
      }
      action={
        <Button
          size="sm"
          disabled={props.disabled !== undefined}
          title={props.disabled}
          onClick={props.onReopen}
        >
          <ArrowClockwiseIcon aria-hidden size={14} />
          {props.liveUrl === undefined ? "Open again" : "Load it here"}
        </Button>
      }
    />
  );
}

/** Offline with nothing to show: say so; the toolbar stays where it is. */
export function Offline() {
  return (
    <EmptyState
      icon={WifiSlashIcon}
      title="ace is offline"
      description="The page comes back once ace reconnects to ace."
    />
  );
}
