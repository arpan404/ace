/*
 * How much the marketing site measures for one visitor. Pure, so the rules are tested without a
 * browser; marketing-analytics.ts feeds it the visitor's saved choice, browser signal and country.
 *
 * "full" keeps a PostHog id in browser storage and records the session. "anonymous" stores
 * nothing and counts visits with a server-side hash, which needs no consent prompt.
 */

export type AnalyticsMode = "full" | "anonymous";

/** The visitor's own choice from the footer, as saved in browser storage. */
export type AnalyticsChoice = "on" | "off";

// The EEA, the United Kingdom and Switzerland require consent before storing an id or recording.
const consentCountries = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(
    " ",
  ),
);

export function isAnalyticsChoice(value: string | null | undefined): value is AnalyticsChoice {
  return value === "on" || value === "off";
}

/** The visitor's two-letter country from Cloudflare's `/cdn-cgi/trace` text, if it names one. */
export function countryFromTrace(trace: string): string | undefined {
  const country = /^loc=([A-Z]{2})$/m.exec(trace)?.[1];
  return country === "XX" || country === "T1" ? undefined : country;
}

/** Whether the country must be resolved before deciding; a saved choice or opt-out signal wins. */
export function needsCountry(choice: AnalyticsChoice | undefined, optOutSignal: boolean) {
  return choice === undefined && !optOutSignal;
}

/**
 * A saved choice always wins. Otherwise a browser opt-out signal (Global Privacy Control), a
 * consent country, or an unknown country keeps the visit anonymous.
 */
export function analyticsMode(input: {
  choice: AnalyticsChoice | undefined;
  optOutSignal: boolean;
  country: string | undefined;
}): AnalyticsMode {
  if (input.choice) return input.choice === "on" ? "full" : "anonymous";
  if (input.optOutSignal || !input.country || consentCountries.has(input.country)) {
    return "anonymous";
  }
  return "full";
}
