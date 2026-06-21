"use client";

import { useState, type ImgHTMLAttributes } from "react";

import { cn, resolveServerUrl } from "~/lib/utils";

function buildIssueImageSource(
  rawSrc: string | undefined,
  cwd: string | null | undefined,
): { primarySrc: string | undefined; fallbackSrc: string | undefined } {
  if (!rawSrc) {
    return { primarySrc: rawSrc, fallbackSrc: undefined };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawSrc);
  } catch {
    return { primarySrc: rawSrc, fallbackSrc: undefined };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isGitHubHosted =
    parsed.protocol === "https:" &&
    (hostname === "github.com" ||
      hostname.endsWith(".githubusercontent.com") ||
      hostname.endsWith(".githubassets.com"));

  if (!isGitHubHosted || !cwd) {
    return { primarySrc: rawSrc, fallbackSrc: undefined };
  }

  return {
    primarySrc: resolveServerUrl({
      protocol: "http",
      pathname: "/api/github-issue-image",
      searchParams: {
        cwd,
        url: rawSrc,
      },
    }),
    fallbackSrc: rawSrc,
  };
}

function IssueImageSource(
  props: ImgHTMLAttributes<HTMLImageElement> & {
    fallbackSrc: string | null;
    primarySrc: string;
  },
) {
  const { fallbackSrc, primarySrc, ...imgProps } = props;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [resolvedSrc, setResolvedSrc] = useState(primarySrc);

  const handleError = () => {
    if (fallbackSrc && resolvedSrc !== fallbackSrc) {
      setResolvedSrc(fallbackSrc);
      setStatus("loading");
      return;
    }
    setStatus("error");
  };
  const handleLoad = () => setStatus("loaded");

  if (status === "error") {
    return (
      <span className="my-2 flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <svg
          className="size-4 shrink-0 opacity-50"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 16l5-5 3 3 4-4 6 6" />
          <circle cx="8.5" cy="8.5" r="1.5" />
        </svg>
        Image failed to load
      </span>
    );
  }

  return (
    <>
      {status === "loading" ? (
        <span className="my-2 block h-32 w-full animate-pulse rounded-md bg-muted/30" />
      ) : null}
      <img
        {...imgProps}
        src={resolvedSrc}
        alt={imgProps.alt ?? ""}
        onError={handleError}
        onLoad={handleLoad}
        className={cn(
          "my-2 max-h-[28rem] max-w-full rounded-md border border-border/40 object-contain",
          status === "loading" && "sr-only",
        )}
      />
    </>
  );
}

export function IssueImage(props: ImgHTMLAttributes<HTMLImageElement> & { cwd?: string | null }) {
  const { cwd, ...imgProps } = props;
  const { primarySrc, fallbackSrc } = buildIssueImageSource(imgProps.src, cwd);

  return (
    <IssueImageSource
      key={primarySrc}
      fallbackSrc={fallbackSrc ?? null}
      primarySrc={primarySrc ?? ""}
      {...imgProps}
    />
  );
}
