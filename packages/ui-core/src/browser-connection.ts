/*
 * How the browser's connection reads, shared by web and the phone: the page's security at the
 * address's start, and the person's input round trip once "Show connection stats" is on.
 */

/** How the page's connection reads: secure (https), not secure (http elsewhere), or local. */
export type PageConnection = "secure" | "insecure" | "local";

export function pageConnection(url: string | undefined): PageConnection {
  if (!url) return "local";
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    if (parsed.protocol === "https:") return "secure";
    const host = parsed.hostname;
    return host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
      ? "local"
      : "insecure";
  } catch {
    return "local";
  }
}

/** The words for each connection, for its mark's label. */
export const pageConnectionLabels: Record<PageConnection, string> = {
  secure: "Secure connection",
  insecure: "Not secure",
  local: "Local page",
};

/**
 * The input round trip shown in the ⋯ menu: a moving average, so one slow request moves it
 * a little and a lasting change shows within a few. The first sample is taken as it is.
 */
export function nextLatency(previous: number | undefined, sample: number): number {
  if (!Number.isFinite(sample) || sample < 0) return previous ?? 0;
  if (previous === undefined) return sample;
  return previous + (sample - previous) * 0.25;
}
