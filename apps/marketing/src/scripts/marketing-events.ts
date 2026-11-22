import type { PostHog } from "posthog-js";
import { isArch, isFileKind, isPlatform } from "../content/release-pick.ts";
import { links } from "../site.ts";
import { githubTarget, makerAction, tabChosenEvent, type TabChosen } from "./named-events.ts";

/*
 * The marketing site's named PostHog events, on top of autocapture: downloads, GitHub links,
 * tab choices, opened questions and the Spade maker. Each listener is delegated from the
 * document, so it covers every page without the components knowing about analytics.
 */

// A link that leaves the page may unload it before a batched request goes out.
const leaving = { transport: "sendBeacon", send_instantly: true } as const;

// The footer has its own nav lists, so it is checked first.
function placement(element: Element) {
  if (element.closest("footer")) return "footer";
  if (element.closest("header, nav")) return "nav";
  return "page";
}

function trackLink(event: MouseEvent, analytics: PostHog) {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>("a[href]");
  if (!link) return;

  const file = link.dataset.file ?? link.dataset.download;
  if (file !== undefined) {
    const [platform, kind, arch] = file.split(":");
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
      leaving,
    );
    return;
  }

  const target = githubTarget(link.href);
  if (target) {
    analytics.capture("marketing_github_clicked", { target, placement: placement(link) }, leaving);
  }
}

function trackMaker(analytics: PostHog) {
  // One event per action per page view: enough to count who tries the maker, not every keystroke.
  const sent = new Set<string>();
  const send = (element: EventTarget | null) => {
    // The options are faces drawn in SVG, so the target may not be an HTML element.
    if (!(element instanceof Element)) return;
    const control = element.closest<HTMLElement>(
      "[data-shuffle], [data-part-field], [data-options] [data-value], [data-name], [data-task]",
    );
    if (!control?.closest("[data-maker]")) return;
    const action = makerAction(control.dataset, control.closest("[data-options]") !== null);
    if (!action || sent.has(action)) return;
    sent.add(action);
    analytics.capture("marketing_bot_maker_used", { action });
  };
  // Caught on the way down, before the maker redraws the control that was clicked.
  document.addEventListener("click", (event) => send(event.target), true);
  document.addEventListener("input", (event) => send(event.target));
}

export function trackNamedEvents(analytics: PostHog) {
  document.addEventListener("click", (event) => trackLink(event, analytics));
  document.addEventListener("auxclick", (event) => {
    if (event.button === 1) trackLink(event, analytics);
  });

  document.addEventListener(tabChosenEvent, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const { list, tab } = event.detail as TabChosen;
    analytics.capture("marketing_tab_chosen", { tab_list: list, tab });
  });

  // toggle doesn't bubble, so it is caught on the way down.
  document.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.open) return;
      if (!details.hasAttribute("data-question")) return;
      const question = details.querySelector("summary")?.textContent?.trim();
      if (question) analytics.capture("marketing_question_opened", { question });
    },
    true,
  );

  trackMaker(analytics);
}
