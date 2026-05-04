"use client";

import { memo, useCallback, useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn, resolveServerUrl } from "~/lib/utils";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeRaw];

/**
 * Regex to match GitHub-specific `<img>` HTML tags in issue/comment bodies.
 * GitHub's API returns image attachments as raw HTML rather than markdown syntax.
 */
const HTML_IMG_TAG_REGEX = /<img\b[^>]*>/gi;
const HTML_ATTR_REGEX = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Converts GitHub-flavored HTML image tags to standard markdown image syntax.
 * GitHub issue bodies often contain `<img src="..." alt="...">` instead of `![alt](url)`.
 */
export function normalizeGitHubIssueMarkdown(text: string): string {
  return text.replace(HTML_IMG_TAG_REGEX, (tag) => {
    let src: string | null = null;
    let alt = "";
    HTML_ATTR_REGEX.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = HTML_ATTR_REGEX.exec(tag)) !== null) {
      const key = attrMatch[1];
      if (!key) continue;
      const normalizedKey = key.toLowerCase();
      const value = (attrMatch[2] ?? attrMatch[3] ?? "").trim();
      if (normalizedKey === "src" && value.length > 0) {
        src = value;
      } else if (normalizedKey === "alt") {
        alt = value;
      }
    }
    if (!src) return tag;
    const escapedAlt = alt.replaceAll("[", "\\[").replaceAll("]", "\\]");
    return `![${escapedAlt}](${src})`;
  });
}

/**
 * Formats an ISO date string into a concise calendar label.
 */
export function formatIssueRelativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((today.getTime() - targetDay.getTime()) / 86_400_000);

  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";

  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}

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

function IssueImage(props: ImgHTMLAttributes<HTMLImageElement> & { cwd?: string | null }) {
  const { cwd, ...imgProps } = props;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const { primarySrc, fallbackSrc } = useMemo(
    () => buildIssueImageSource(imgProps.src, cwd),
    [cwd, imgProps.src],
  );
  const [resolvedSrc, setResolvedSrc] = useState(primarySrc);

  useEffect(() => {
    setResolvedSrc(primarySrc);
    setStatus("loading");
  }, [primarySrc]);

  const handleError = useCallback(() => {
    if (fallbackSrc && resolvedSrc !== fallbackSrc) {
      setResolvedSrc(fallbackSrc);
      setStatus("loading");
      return;
    }
    setStatus("error");
  }, [fallbackSrc, resolvedSrc]);
  const handleLoad = useCallback(() => setStatus("loaded"), []);

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

interface IssueMarkdownProps {
  text: string;
  className?: string;
  cwd?: string | null;
}

function IssueMarkdownInner({ text, className, cwd }: IssueMarkdownProps) {
  const normalized = normalizeGitHubIssueMarkdown(text);
  const components = useMemo(
    () => ({
      img: (props: ImgHTMLAttributes<HTMLImageElement>) => (
        <IssueImage {...props} cwd={cwd ?? null} />
      ),
    }),
    [cwd],
  );

  return (
    <div
      className={cn(
        "issue-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
        "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-foreground",
        "[&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground",
        "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-foreground",
        "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5",
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border/60 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_code]:text-foreground/90",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/30 [&_pre]:p-3",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_hr]:my-4 [&_hr]:border-border/40",
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border/40 [&_th]:bg-muted/20 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium",
        "[&_td]:border [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

export const IssueMarkdown = memo(IssueMarkdownInner);
