import { coldStartReplay } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** Pretend the window is `width` px wide: media queries answer as a browser would. */
function windowWidth(width: number) {
  const matches = (query: string) =>
    [...query.matchAll(/\((min|max)-width:\s*([\d.]+)rem\)/g)].every(([, bound, rem]) => {
      const px = Number(rem) * 16;
      return bound === "min" ? width >= px : width <= px;
    });
  globalThis.matchMedia = (query: string) =>
    ({
      matches: !query.includes("width") ? false : matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
}
const original = globalThis.matchMedia;
afterEach(() => {
  globalThis.matchMedia = original;
});

const sidebar = () => screen.queryByRole("complementary", { name: "Threads" });

async function openThread() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

test("on a phone the views are a bottom tab bar, and More reaches the rest", async () => {
  windowWidth(390);
  await openThread();
  const views = screen.getByRole("navigation", { name: "Views" });
  expect(within(views).getByRole("link", { name: /Home/ }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(within(views).queryByRole("link", { name: /Automations/ })).toBeNull();

  await userEvent.click(within(views).getByRole("button", { name: "More views" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Automations" }));
  await screen.findByRole("heading", { level: 2, name: "Nightly dependency audit" });
});

test("on a phone the header keeps one ⋯ for the actions and the thread menu, and no history", async () => {
  windowWidth(390);
  await openThread();
  const header = screen.getByRole("banner");
  expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
  const overflow = within(header).getAllByRole("button", { name: "More actions" });
  expect(overflow).toHaveLength(1);

  await userEvent.click(overflow[0]!);
  expect(await screen.findByRole("button", { name: "Open" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
  expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeTruthy();
});

test("on a phone a panel covers the thread as a sheet with its own close", async () => {
  windowWidth(390);
  await openThread();
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).queryByRole("separator", { name: /Resize/ })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Close thread panel" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
});

test("below 1100px the sidebar steps aside for the right panel and comes back when it closes", async () => {
  windowWidth(1024);
  await openThread();
  expect(sidebar()).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(sidebar()).toBeNull());

  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(sidebar()).toBeTruthy());
});
