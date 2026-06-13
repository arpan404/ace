import { GlobeIcon, RotateCwIcon } from "lucide-react";

import type { BrowserLoadFailure } from "./BrowserWebviewSurface";

export function BrowserLoadErrorPage(props: { failure: BrowserLoadFailure; onRetry: () => void }) {
  const hostLabel = (() => {
    try {
      return new URL(props.failure.url).host;
    } catch {
      return props.failure.url;
    }
  })();

  return (
    <div className="absolute inset-0 z-10 min-h-0 overflow-auto bg-background px-10 py-16 text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-5">
        <GlobeIcon className="size-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-normal">This page could not load</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Ace could not reach <span className="font-medium text-foreground">{hostLabel}</span>.
            Check the address or your connection, then try again.
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {props.failure.code !== null ? `ERR ${String(props.failure.code)}: ` : ""}
            {props.failure.message}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={props.onRetry}
        >
          <RotateCwIcon className="size-4" aria-hidden="true" />
          Retry
        </button>
      </div>
    </div>
  );
}
