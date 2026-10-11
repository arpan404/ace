import type { ProviderLoginProgress } from "@ace/protocol";
import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { openExternal, opensWithoutClick } from "@/boot/open-external.ts";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Actions, StepTitle, useFocusOnShow, Waiting } from "./login-parts.tsx";

/*
 * The browser half of a sign-in: a device code to type on the provider's page, or just the page
 * to finish on. The link opens on this device; the CLI on the daemon's computer finishes the
 * sign-in once the person has.
 */

const copiedMs = 1_600;

/** Copy text, then say "Copied" for a moment. False until then, or when copying failed. */
function useCopy(): [
  state: "idle" | "copied" | "failed",
  copy: (text: string) => Promise<boolean>,
] {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), copiedMs);
      return true;
    } catch {
      setState("failed");
      return false;
    }
  };
  return [state, copy];
}

/** Open the sign-in page on this device: the system browser from the app, a tab from a browser. */
function openPage(url: string) {
  void openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
}

/** "ACEF-2048" as large monospace cells, a gap where the dash is. */
function CodeCells(props: { code: string }) {
  return (
    <span aria-label="Sign-in code" className="flex items-center gap-1 font-mono">
      {[...props.code].map((char, at) =>
        char === "-" || char === " " ? (
          <span
            // A code's characters never move.
            // oxlint-disable-next-line react/no-array-index-key
            key={at}
            className="w-3 text-center text-lg text-subtle-foreground"
          >
            {char}
          </span>
        ) : (
          <span
            // oxlint-disable-next-line react/no-array-index-key
            key={at}
            className="grid h-11 w-8 place-items-center rounded-sm bg-secondary text-xl font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
          >
            {char}
          </span>
        ),
      )}
    </span>
  );
}

/** Enter a code on the provider's page: the code, a click that copies it and opens the page. */
export function CodeStep(props: { progress: ProviderLoginProgress; footer: React.ReactNode }) {
  const { url, userCode } = props.progress;
  const primary = useFocusOnShow<HTMLAnchorElement>();
  const [code, copyCode] = useCopy();
  if (!userCode) return null;
  return (
    <>
      <StepTitle
        title="Enter this code on the sign-in page"
        line="Sign in on the provider’s page, then enter this one-time code."
      />
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => void copyCode(userCode)}
          className="rounded-md p-1.5 transition-colors duration-(--dur-1) focus-ring hover:bg-accent"
        >
          <CodeCells code={userCode} />
          <span className="sr-only">Copy code</span>
        </button>
        <p role="status" className="flex h-5 items-center gap-1 text-sm text-muted-foreground">
          {code === "copied" ? (
            <>
              <CheckIcon aria-hidden size={13} className="text-status-done" /> Copied
            </>
          ) : code === "failed" ? (
            "Couldn't copy. Type the code on the page instead."
          ) : (
            "Click the code to copy it"
          )}
        </p>
      </div>
      <Actions>
        {url && (
          <a
            ref={primary}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "primary", size: "lg" })}
            onClick={(event) => {
              event.preventDefault();
              // The code goes on the clipboard first, ready to paste on the page.
              void copyCode(userCode).finally(() => openPage(url));
            }}
          >
            Copy code and open sign-in page
            <ArrowSquareOutIcon aria-hidden size={14} />
          </a>
        )}
      </Actions>
      <Waiting text="Waiting for you to finish in your browser" />
      {props.footer}
    </>
  );
}

/**
 * Finish on the provider's page. The desktop app opens it as soon as the link arrives (the
 * person's Sign in click asked for it); a browser tab would block that as a pop-up, so there the
 * button opens it.
 */
export function BrowserStep(props: {
  progress: ProviderLoginProgress;
  /** True the first time it's asked for this sign-in: the page opens by itself only once. */
  claimOpen(): boolean;
  compact?: boolean;
  footer: React.ReactNode;
}) {
  const { url } = props.progress;
  const primary = useFocusOnShow<HTMLAnchorElement>();
  // The desktop app opens it as the link arrives; the button then opens it again.
  const opened = url !== undefined && opensWithoutClick();
  const claimOpen = useEffectEvent(() => props.claimOpen());
  useEffect(() => {
    if (url && opensWithoutClick() && claimOpen()) openPage(url);
  }, [url]);
  return (
    <>
      {!props.compact && (
        <StepTitle
          title="Continue in your browser"
          line={
            opened
              ? "The sign-in page is open in your browser. Come back here when you're done."
              : "Open the sign-in page and finish there. ace picks it up on its own."
          }
        />
      )}
      {url && (
        <Actions>
          <a
            ref={primary}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: opened ? "secondary" : "primary", size: "lg" })}
            onClick={(event) => {
              event.preventDefault();
              openPage(url);
            }}
          >
            {props.compact
              ? "Open again"
              : opened
                ? "Open sign-in page again"
                : "Open sign-in page"}
            <ArrowSquareOutIcon aria-hidden size={14} />
          </a>
        </Actions>
      )}
      <Waiting
        text={
          props.compact
            ? "Waiting for you to finish signing in…"
            : "Waiting for you to finish in your browser"
        }
      />
      {props.footer}
    </>
  );
}

/** "Copy link" for finishing on another device, and Cancel. */
export function ChallengeFooter(props: { url: string | undefined; cancel: React.ReactNode }) {
  const [link, copyLink] = useCopy();
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-3">
      {props.url ? (
        <Button size="sm" variant="ghost" onClick={() => void copyLink(props.url ?? "")}>
          {link === "copied" ? (
            <CheckIcon aria-hidden size={13} className="text-status-done" />
          ) : (
            <CopyIcon aria-hidden size={13} />
          )}
          {link === "copied" ? "Link copied" : "Copy link"}
        </Button>
      ) : (
        <span />
      )}
      {props.cancel}
    </div>
  );
}
