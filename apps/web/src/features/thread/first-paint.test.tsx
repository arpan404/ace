import { flakyCheckout } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

/** jsdom has no layout notifications: each observer is kept so a test can deliver sizes. */
class Observer implements ResizeObserver {
  static all = new Set<Observer>();
  readonly targets = new Set<Element>();
  readonly changed: ResizeObserverCallback;
  constructor(changed: ResizeObserverCallback) {
    this.changed = changed;
    Observer.all.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    Observer.all.delete(this);
  }
}

const rowsOf = (feed: HTMLElement) => [
  ...feed.querySelectorAll<HTMLElement>(':scope > [role="article"]'),
];
const topOf = (row: HTMLElement) =>
  Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);

/** The browser reports these rows at `height` from their observer, as it does before a paint. */
function resize(rows: readonly HTMLElement[], height: number) {
  const observer = [...Observer.all].find((each) => rows.every((row) => each.targets.has(row)));
  if (!observer) throw new Error("the transcript's rows are not observed");
  const size = [{ blockSize: height, inlineSize: 800 }];
  const entries = rows.map((target): ResizeObserverEntry => ({
    target,
    borderBoxSize: size,
    contentBoxSize: size,
    devicePixelContentBoxSize: size,
    contentRect: target.getBoundingClientRect(),
  }));
  observer.changed(entries, observer);
}

test("rows that fill in after a thread opens move the rows under them before the next paint", async () => {
  Observer.all.clear();
  vi.stubGlobal("ResizeObserver", Observer);
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByRole("link", { name: "Waiting for your approval" });
  await waitFor(() => expect(rowsOf(feed).length).toBeGreaterThan(3));
  const rows = rowsOf(feed);

  // Their text arrives: every row is now 120px tall. Only microtasks run before the browser
  // paints, so whatever the rows show then is what the person sees.
  const act = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const acting = act.IS_REACT_ACT_ENVIRONMENT;
  act.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    resize(rows, 120);
    await Promise.resolve();
    await Promise.resolve();
    const tops = rowsOf(feed).map(topOf);
    for (let index = 1; index < tops.length; index++)
      expect(tops[index]).toBeGreaterThanOrEqual((tops[index - 1] ?? 0) + 120);
  } finally {
    act.IS_REACT_ACT_ENVIRONMENT = acting;
  }
});

test("a thread opening on an approval shows its request strip in the same paint as its transcript", async () => {
  let together: boolean | undefined;
  const watch = new MutationObserver(() => {
    if (together !== undefined) return;
    const feed = document.querySelector('[role="feed"]');
    if (!feed?.querySelector('[role="article"]')) return;
    together = !!document.querySelector('[role="region"][aria-label="Waiting for you"]');
  });
  watch.observe(document.body, { childList: true, subtree: true });
  try {
    const app = harness();
    app.play(flakyCheckout()).runThrough("approval-requested");
    await app.open("/t/thread-checkout");
    const strip = await screen.findByRole("region", { name: "Waiting for you" });
    expect(
      within(strip).getByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" }),
    ).toBeTruthy();
    expect(together).toBe(true);
  } finally {
    watch.disconnect();
  }
});
