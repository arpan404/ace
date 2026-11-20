import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threads = () => screen.getByRole("navigation", { name: "Projects" });
/** A wide window whose person asked for less motion. */
const reducedMotion = (query: string) =>
  ({
    matches: query.includes("prefers-reduced-motion") || query.includes("min-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;

async function openHome(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Projects" })).findAllByRole("link");
  return app;
}

async function archive(title: RegExp) {
  const target = within(threads()).getByRole("link", { name: title });
  await userEvent.pointer({ keys: "[MouseRight]", target });
  const menu = await screen.findByRole("menu", { name: /^Actions for/ });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
}

test("an archived card leaves the list at once for assistive tech, then fades out of the way", async () => {
  await openHome();
  const before = within(threads()).getAllByRole("listitem").length;
  // The fade lasts 140 ms, less than a click and a render take on a busy machine, so the list is
  // looked at after every change to it rather than once the click returns.
  const states: { link: boolean; fading: boolean }[] = [];
  const observer = new MutationObserver(() => {
    const list = threads();
    const card = within(list).queryByText("Invoice PDF locale fallback");
    states.push({
      link: within(list).queryByRole("link", { name: /Invoice PDF locale fallback/ }) !== null,
      fading: card?.closest("[inert]") != null,
    });
  });
  observer.observe(threads(), { subtree: true, childList: true, attributes: true });
  await archive(/Invoice PDF locale fallback/);

  // It is no longer offered as a thread while it fades, and it can't be clicked meanwhile.
  await waitFor(() =>
    expect(
      within(threads()).queryByRole("link", { name: /Invoice PDF locale fallback/ }),
    ).toBeNull(),
  );
  expect(states).toContainEqual({ link: false, fading: true });

  // Once the exit has played the card is gone, and the list is one row shorter.
  await waitFor(() =>
    expect(within(threads()).queryByText("Invoice PDF locale fallback")).toBeNull(),
  );
  expect(within(threads()).getAllByRole("listitem")).toHaveLength(before - 1);
  observer.disconnect();
});

test("with reduced motion an archived card is gone in the same moment", async () => {
  await openHome({ matchMedia: reducedMotion });
  await archive(/Invoice PDF locale fallback/);
  expect(within(threads()).queryByText("Invoice PDF locale fallback")).toBeNull();
});
