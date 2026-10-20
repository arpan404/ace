import { useClient } from "@ace/client-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  maxHtmlBytes,
  themeProperties,
  validateHtml,
  type HtmlTheme,
  type ThemeProperty,
} from "@ace/html";

/** Where a page variable comes from in the app theme, when the names differ. */
const appToken: Partial<Record<ThemeProperty, string>> = {
  "card-foreground": "--foreground",
  accent: "--ring",
  "accent-foreground": "--ring-foreground",
  "accent-text": "--ring-text",
  success: "--status-done",
  warning: "--status-needs-you",
  info: "--status-working",
};

function readTheme(): HtmlTheme {
  const style = getComputedStyle(document.documentElement);
  const scheme = style.colorScheme.trim();
  return {
    ...Object.fromEntries(
      themeProperties.map((name) => [
        name,
        style.getPropertyValue(appToken[name] ?? `--${name}`).trim(),
      ]),
    ),
    ...(scheme === "dark" || scheme === "light" ? { colorScheme: scheme } : {}),
  };
}

const sameTheme = (a: HtmlTheme, b: HtmlTheme) =>
  a.colorScheme === b.colorScheme && themeProperties.every((name) => a[name] === b[name]);

/** The app theme, re-read whenever the root's theme attributes change. */
export function useHtmlTheme(): HtmlTheme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme((current) => {
        const next = readTheme();
        return sameTheme(current, next) ? current : next;
      }),
    );
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The stored page a visualization points at: its thread-scoped content id. */
export interface PageDocument {
  sha256: string;
  bytes: number;
}

/**
 * Fetches and validates the page's bytes from the owning daemon. Pages are content-addressed, so
 * the reply, the side panel and its buttons share one cached copy.
 */
export function usePageHtml(threadId: string, page: PageDocument) {
  const client = useClient();
  const { sha256, bytes } = page;
  const query = useQuery({
    queryKey: ["thread", threadId, "visualization-page", sha256],
    queryFn: async ({ signal }) => {
      const result = await client.attachmentBytes(
        { threadId, sha256, variant: "original", maxBytes: Math.min(bytes, maxHtmlBytes) },
        { signal },
      );
      const html = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      if (result.bytes.byteLength > maxHtmlBytes || !validateHtml(html).valid)
        throw new Error("Invalid HTML attachment");
      return html;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return {
    html: query.data,
    failed: query.isError,
    retry: () => void query.refetch(),
  };
}
