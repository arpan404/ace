import { ArrowSquareOutIcon, BrowserIcon } from "@phosphor-icons/react";
import { addressHost, displayAddress, type BrowserFailure } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { LoadFailed } from "../browser/page-states.tsx";
import { toolbarButton } from "../browser/page-toolbar.tsx";

export type FramePhase = "loading" | "loaded" | "blank" | "failed";

/** A dev server that never finishes loading is treated as failed after this long. */
const loadTimeoutMs = 20_000;

/**
 * Whether anything answers at `url`. A no-cors request resolves with an opaque response from
 * any server and rejects when nothing listens; a page served over https can't ask an http
 * address (mixed content), so there the frame's own load decides.
 */
export async function reachable(url: string, signal: AbortSignal): Promise<boolean> {
  if (typeof fetch !== "function") return true;
  if (globalThis.location?.protocol === "https:" && url.startsWith("http:")) return true;
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal });
    return true;
  } catch {
    return !!signal.aborted;
  }
}

const unreachable = (url: string): BrowserFailure => ({
  title: `Couldn't reach ${addressHost(url) ?? displayAddress(url)}`,
  detail:
    "Nothing answered at this address. The dev server may have stopped, still be starting, or listen on another port.",
});
const tooSlow = (url: string): BrowserFailure => ({
  title: `${addressHost(url) ?? displayAddress(url)} didn't finish loading`,
  detail: "The page took more than 20 seconds. Try again once the dev server has settled.",
});

/** The document has nothing to show (where the browser lets ace look: same-origin pages). */
function isBlank(frame: HTMLIFrameElement): boolean {
  try {
    const body = frame.contentDocument?.body;
    return !!body && body.children.length === 0 && !body.textContent?.trim();
  } catch {
    return false;
  }
}

/**
 * Loading a dev server into a frame: `loading` until the frame's load event and the server
 * answering, then `loaded`, `blank` (an empty document), or `failed` (nothing answered, or the
 * load ran past 20 seconds). Changing `attempt` loads again.
 */
function useFrameLoad(url: string, attempt: number) {
  const [state, setState] = useState<{ key: string; phase: FramePhase; failure?: BrowserFailure }>({
    key: "",
    phase: "loading",
  });
  const key = `${url}\u0000${attempt}`;
  const loaded = useRef(false);
  const answered = useRef<boolean | undefined>(undefined);
  const frame = useRef<HTMLIFrameElement>(null);
  const current = state.key === key ? state : { key, phase: "loading" as const };
  useEffect(() => {
    loaded.current = false;
    answered.current = undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () => setState({ key, phase: "failed", failure: tooSlow(url) }),
      loadTimeoutMs,
    );
    void reachable(url, controller.signal).then((ok) => {
      if (controller.signal.aborted) return;
      answered.current = ok;
      if (!ok) {
        clearTimeout(timer);
        setState({ key, phase: "failed", failure: unreachable(url) });
      } else if (loaded.current) {
        clearTimeout(timer);
        setState({ key, phase: frame.current && isBlank(frame.current) ? "blank" : "loaded" });
      }
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, url]);
  const onLoad = () => {
    loaded.current = true;
    if (answered.current === true)
      setState({ key, phase: frame.current && isBlank(frame.current) ? "blank" : "loaded" });
  };
  return { phase: current.phase, failure: current.failure, frame, onLoad };
}

/**
 * A dev server's page, edge to edge on the theme's background until it paints: a spinner
 * while it loads, the address with what happened and Reload when it fails, and a quiet note
 * when the page has nothing in it. The frame stays mounted throughout; `onPhase` tells the
 * toolbar and the tab when it is loading.
 */
export function DevServerFrame(props: {
  url: string;
  attempt: number;
  onPhase(phase: FramePhase): void;
  onRetry(): void;
}) {
  const { url, onPhase } = props;
  const { phase, failure, frame, onLoad } = useFrameLoad(url, props.attempt);
  useEffect(() => onPhase(phase), [onPhase, phase]);
  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <iframe
        ref={frame}
        key={props.attempt}
        title={`Preview of ${url}`}
        src={url}
        onLoad={onLoad}
        // The page is the user's own dev server on another origin, so the browser already
        // isolates it; it needs scripts and its own storage to work.
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        className={cn(
          "absolute inset-0 size-full border-0 bg-background",
          phase !== "loaded" && "invisible",
        )}
      />
      {phase === "loading" && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center gap-2 text-ui text-muted-foreground"
        >
          <Spinner />
          Loading {displayAddress(url)}…
        </div>
      )}
      {phase === "failed" && failure && (
        <div className="absolute inset-0 overflow-auto">
          <LoadFailed url={url} failure={failure} onReload={props.onRetry} />
        </div>
      )}
      {phase === "blank" && (
        <div className="absolute inset-0">
          <EmptyState
            icon={BrowserIcon}
            title="The page is blank"
            description={`${displayAddress(url)} loaded, but its page has nothing in it yet. Reload once the dev server has built it.`}
          />
        </div>
      )}
    </div>
  );
}

/** Why a preview has no Back or Forward: its page's history stays inside the frame. */
export const noHistory = "a preview's page history stays inside it; use the page's own links";

/** The address in this device's own browser. */
export function OpenOutside(props: { url: string }) {
  const toast = useToast();
  return (
    <IconButton
      icon={ArrowSquareOutIcon}
      label="Open in your browser"
      className={toolbarButton}
      onClick={() =>
        void openExternal(props.url).catch((error: unknown) =>
          toast.add({
            title: "Couldn't open the page",
            description: error instanceof Error ? error.message : undefined,
          }),
        )
      }
    />
  );
}
