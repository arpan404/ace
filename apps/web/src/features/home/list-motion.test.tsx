import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const threads = () => screen.getByRole("navigation", { name: "Threads" });
/** A wide window whose person asked for less motion. */
const reducedMotion = (query: string) =>
  ({
    matches: query.includes("prefers-reduced-motion") || query.includes("min-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;

async function openHome() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  return app;
}

test("a settled card leaves the list at once for assistive tech, then fades out of the way", async () => {
  await openHome();
  const before = within(threads()).getAllByRole("listitem").length;
  await userEvent.click(screen.getByRole("button", { name: "Settle Invoice PDF locale fallback" }));

  // It is no longer offered as a thread while it fades, and it can't be clicked meanwhile.
  expect(within(threads()).queryByRole("link", { name: /Invoice PDF locale fallback/ })).toBeNull();
  const fading = within(threads()).getByText("Invoice PDF locale fallback");
  expect(fading.closest("[inert]")).not.toBeNull();

  // Once the exit has played the card is gone and the list is one row shorter.
  await waitFor(() =>
    expect(within(threads()).queryByText("Invoice PDF locale fallback")).toBeNull(),
  );
  expect(within(threads()).getAllByRole("listitem")).toHaveLength(before - 1);
});

test("with reduced motion a settled card is gone in the same moment", async () => {
  vi.stubGlobal("matchMedia", reducedMotion);
  await openHome();
  await userEvent.click(screen.getByRole("button", { name: "Settle Invoice PDF locale fallback" }));
  expect(within(threads()).queryByText("Invoice PDF locale fallback")).toBeNull();
});
