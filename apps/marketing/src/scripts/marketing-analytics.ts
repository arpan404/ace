import type { PostHog } from "posthog-js";
import { isArch, isFileKind, isPlatform } from "../content/release-pick.ts";
import { links } from "../site.ts";

const preferenceKey = "ace-marketing-analytics";

function savedPreference() {
  try {
    return localStorage.getItem(preferenceKey);
  } catch {
    return null;
  }
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

export function setupMarketingAnalytics() {
  const panel = document.querySelector<HTMLElement>("#analytics-consent");
  const projectKey = panel?.dataset.projectKey;
  const host = panel?.dataset.apiHost;
  if (!panel || !projectKey || !host) return;

  const settings = document.querySelector<HTMLButtonElement>("[data-analytics-settings]");
  let preference = savedPreference();
  let analytics: PostHog | undefined;
  let capturing = false;
  let openedFromSettings = false;

  const start = async () => {
    const { default: posthog } = await import("posthog-js");
    // The visitor may withdraw consent before the SDK finishes loading.
    if (preference !== "on" || capturing) return;

    analytics ??= posthog.init(projectKey, {
      api_host: host,
      defaults: "2026-06-25",
      person_profiles: "never",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      opt_out_persistence_by_default: true,
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: { dom_event_allowlist: ["click"] },
      enable_heatmaps: true,
      capture_performance: { web_vitals: true, network_timing: false },
      capture_exceptions: false,
      disable_surveys: true,
      disable_web_experiments: true,
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        blockSelector: "input[type=file], [data-private]",
        maskCapturedNetworkRequestFn: () => null,
        recordCrossOriginIframes: false,
      },
    });
    analytics.opt_in_capturing({ captureEventName: false });
    if (analytics.config.disable_session_recording) analytics.startSessionRecording();
    capturing = true;
    analytics.capture("$pageview", { title: document.title }, { send_instantly: true });
  };

  const setPanelOpen = (open: boolean) => {
    panel.hidden = !open;
    settings?.setAttribute("aria-expanded", String(open));
  };

  const applyPreference = () => {
    setPanelOpen(preference !== "on" && preference !== "off");
    if (preference === "on") {
      void start().catch(() => {});
    } else {
      analytics?.opt_out_capturing();
      analytics?.stopSessionRecording();
      capturing = false;
    }
  };

  settings?.closest("li")?.removeAttribute("hidden");
  settings?.addEventListener("click", () => {
    openedFromSettings = panel.hasAttribute("hidden");
    setPanelOpen(openedFromSettings);
    if (openedFromSettings) panel.querySelector("h2")?.focus({ preventScroll: true });
  });

  panel.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const choice =
      event.target.closest<HTMLElement>("[data-analytics-choice]")?.dataset.analyticsChoice;
    if (choice !== "on" && choice !== "off") return;
    if (preference !== choice) {
      preference = choice;
      try {
        localStorage.setItem(preferenceKey, choice);
      } catch {
        // Keep the choice on this page if storage is unavailable.
      }
      applyPreference();
    }
    setPanelOpen(false);
    if (openedFromSettings) settings?.focus({ preventScroll: true });
    openedFromSettings = false;
  });

  const syncPreference = () => {
    const saved = savedPreference();
    if (saved === preference) return;
    preference = saved;
    applyPreference();
  };
  window.addEventListener("storage", (event) => {
    if (event.key === preferenceKey || event.key === null) syncPreference();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) syncPreference();
  });

  document.addEventListener("click", (event) => {
    if (preference === "on" && analytics) trackDownload(event, analytics);
  });
  document.addEventListener("auxclick", (event) => {
    if (event.button === 1 && preference === "on" && analytics) trackDownload(event, analytics);
  });
  applyPreference();
}
