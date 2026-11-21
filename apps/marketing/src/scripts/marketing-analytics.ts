import type { PostHog } from "posthog-js";
import { analyticsChoice } from "../content/legal.ts";
import { isArch, isFileKind, isPlatform } from "../content/release-pick.ts";
import { links } from "../site.ts";
import {
  analyticsMode,
  countryFromTrace,
  isAnalyticsChoice,
  needsCountry,
  type AnalyticsChoice,
  type AnalyticsMode,
} from "./analytics-mode.ts";

/*
 * PostHog on acehq.dev, with no banner. Each visit is either "full" (a stored id and session
 * replay) or "anonymous" (cookieless counts); analytics-mode.ts decides which. The footer's
 * recording button switches between them and saves the choice.
 */

const choiceKey = "ace-marketing-analytics";

function savedChoice(): AnalyticsChoice | undefined {
  try {
    const value = localStorage.getItem(choiceKey);
    return isAnalyticsChoice(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveChoice(choice: AnalyticsChoice) {
  try {
    localStorage.setItem(choiceKey, choice);
  } catch {
    // The choice still holds for this page.
  }
}

function optOutSignal() {
  return (
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}

async function visitorCountry(): Promise<string | undefined> {
  try {
    const response = await fetch("/cdn-cgi/trace", { signal: AbortSignal.timeout(2000) });
    return response.ok ? countryFromTrace(await response.text()) : undefined;
  } catch {
    return undefined;
  }
}

function projectConfig() {
  const key = import.meta.env.PUBLIC_POSTHOG_KEY?.trim();
  const region = import.meta.env.PUBLIC_POSTHOG_REGION?.trim().toLowerCase() || "us";
  if (!key?.startsWith("phc_") || (region !== "us" && region !== "eu")) return undefined;
  return { key, host: `https://${region}.i.posthog.com` };
}

function trackDownload(event: MouseEvent, analytics: PostHog) {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>("a[data-download], a[data-file]");
  if (!link) return;

  const [platform, kind, arch] = (link.dataset.file ?? link.dataset.download ?? "").split(":");
  if (!isPlatform(platform)) return;

  analytics.capture(
    "marketing_download_clicked",
    {
      platform,
      destination: link.href.startsWith(`${links.releases}/download/`)
        ? "installer"
        : "release_page",
      ...(isFileKind(kind) && { file_kind: kind }),
      ...(isArch(arch) && { architecture: arch }),
    },
    { transport: "sendBeacon", send_instantly: true },
  );
}

function applyMode(analytics: PostHog, mode: AnalyticsMode) {
  if (mode === "full") {
    analytics.opt_in_capturing({ captureEventName: false });
    analytics.startSessionRecording();
  } else {
    analytics.stopSessionRecording();
    // With cookieless_mode "on_reject", opting out clears PostHog's storage and keeps counting
    // the visit without it.
    analytics.opt_out_capturing();
  }
}

export async function setupMarketingAnalytics() {
  const project = projectConfig();
  if (!project) return;

  let choice = savedChoice();
  const signal = optOutSignal();
  const country = needsCountry(choice, signal) ? await visitorCountry() : undefined;
  let mode = analyticsMode({ choice, optOutSignal: signal, country });

  const { default: posthog } = await import("posthog-js");
  const analytics = posthog.init(project.key, {
    api_host: project.host,
    defaults: "2026-06-25",
    cookieless_mode: "on_reject",
    opt_out_capturing_by_default: true,
    person_profiles: "never",
    persistence: "localStorage",
    cross_subdomain_cookie: false,
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: { dom_event_allowlist: ["click"] },
    enable_heatmaps: true,
    capture_performance: { web_vitals: true, network_timing: false },
    capture_exceptions: false,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_session_recording: true,
    enable_recording_console_log: false,
    session_recording: {
      maskAllInputs: true,
      blockSelector: "input[type=file], [data-private]",
      maskCapturedNetworkRequestFn: () => null,
      recordCrossOriginIframes: false,
    },
  });
  applyMode(analytics, mode);
  analytics.capture("$pageview", { title: document.title }, { send_instantly: true });

  const button = document.querySelector<HTMLButtonElement>("[data-analytics-choice]");
  const showMode = () => {
    if (button)
      button.textContent = mode === "full" ? analyticsChoice.turnOff : analyticsChoice.turnOn;
  };
  showMode();
  button?.closest("li")?.removeAttribute("hidden");
  button?.addEventListener("click", () => {
    choice = mode === "full" ? "off" : "on";
    mode = analyticsMode({ choice, optOutSignal: signal, country });
    saveChoice(choice);
    applyMode(analytics, mode);
    showMode();
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== choiceKey && event.key !== null) return;
    const next = analyticsMode({ choice: savedChoice(), optOutSignal: signal, country });
    if (next === mode) return;
    mode = next;
    applyMode(analytics, mode);
    showMode();
  });

  document.addEventListener("click", (event) => trackDownload(event, analytics));
  document.addEventListener("auxclick", (event) => {
    if (event.button === 1) trackDownload(event, analytics);
  });
}
