import { refuseSymlink } from "./paths.ts";
import type { Page } from "@playwright/test";
import type { PageFacts } from "./checks.ts";

/** Snapshot the visible UI, respecting virtualized transcripts and ignoring code blocks. */
export function pageFacts(options: Pick<PageFacts, "catalogsReady" | "expected">): PageFacts {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into Chromium.
  const visible = (element: Element) =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const texts = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(visible)
      .map((element) => element.innerText.trim())
      .filter(Boolean);
  const feed = document.querySelector('[role="feed"][aria-label="Transcript"]');
  const latestUser = feed?.querySelectorAll('[class~="group/bubble"]');
  const lastUser = latestUser?.item(latestUser.length - 1)?.closest<HTMLElement>("[data-index]");
  const from = Number(lastUser?.dataset.index ?? 0);
  const latest =
    [...(feed?.querySelectorAll<HTMLElement>('[role="note"], [role="status"]') ?? [])]
      .filter(
        (element) =>
          visible(element) &&
          Number(element.closest<HTMLElement>("[data-index]")?.dataset.index ?? Infinity) >= from,
      )
      .map((element) => element.innerText)
      .join("\n") +
    "\n" +
    texts(
      'section[aria-label*="not sent"], section[aria-label*="Not sent"], section[aria-label*="Stopped"], section[aria-label*="stopped"]',
    ).join("\n");
  const queue = [...document.querySelectorAll<HTMLElement>('[aria-label="Queued messages"] li')]
    .filter(visible)
    .map((element) => ({
      text:
        element.querySelector<HTMLElement>("span.font-medium")?.innerText ??
        element.innerText.replace(/Queued|May.have.been.sent|Not sent/g, "").trim(),
      state: /May.have.been.sent|may have reached/i.test(element.innerText)
        ? "uncertain"
        : "queued",
    }));
  const title = document.querySelector<HTMLElement>("h1")?.innerText ?? "";
  const icons = [...document.querySelectorAll('[role="img"]')]
    .filter(visible)
    .filter((element) =>
      /^(Claude(?: Code)?|Codex|OpenAI|OpenCode|Cursor|Pi|Gemini|Antigravity)(?:$| ·)/i.test(
        element.getAttribute("aria-label") ?? "",
      ),
    )
    .map((element) => ({
      name: element.getAttribute("aria-label") ?? "",
      brand: !!element.querySelector("svg path[d], path[d]"),
    }));
  const bubbles = [
    ...document.querySelectorAll<HTMLElement>('[class~="group/answer"], [class~="group/bubble"]'),
  ]
    .filter(visible)
    .map((element) => {
      const copy = element.cloneNode(true);
      if (!(copy instanceof HTMLElement)) return "";
      for (const code of copy.querySelectorAll("pre, code, button, time")) code.remove();
      return copy.textContent?.trim() ?? "";
    })
    .filter(Boolean);
  return {
    text: document.body.innerText,
    titles: [
      ...texts('h1, h2, nav[aria-label="Threads"] a'),
      ...[...document.querySelectorAll("[title]")]
        .filter(visible)
        .map((element) => element.getAttribute("title") ?? ""),
    ],
    bubbles,
    models: texts(
      '[role="listbox"][aria-label="Models"] [role="option"] span.truncate:first-child, button[aria-label^="Model:"], button[aria-label^="Default model:"], table[aria-label="Usage by model"] td:first-child',
    ),
    alerts: [
      ...texts('[role="alert"], [role="alertdialog"], [data-slot="toast-root"]'),
      ...(window.aceSmokeAlerts ?? []),
    ],
    icons,
    ...(location.pathname.startsWith("/t/")
      ? {
          thread: {
            title,
            sent: Boolean(latestUser?.length),
            current: [...document.querySelectorAll('[role="status"], header [role="img"]')]
              .filter(visible)
              .map((element) => element.getAttribute("aria-label") ?? element.textContent)
              .join("\n"),
            latest,
            queued: queue,
          },
        }
      : {}),
    ...options,
  };
}
/** Redact screenshot text in place, then restore it so the app's DOM stays usable. */
export async function privateScreenshot(page: Page, path: string, scrub: (text: string) => string) {
  await refuseSymlink(path);
  const original = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const text: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      text.push(node.textContent ?? "");
    return text;
  });
  const redacted = original.map(scrub);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into Chromium.
  const replace = (values: string[]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let index = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = values[index++];
      if (value !== undefined && value !== node.textContent) node.textContent = value;
    }
  };
  await page.evaluate(replace, redacted);
  try {
    await page.screenshot({ path, animations: "disabled" });
  } finally {
    await page.evaluate(replace, original);
  }
}
