import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => vi.unstubAllGlobals());

test("on a phone, tapping a request opens its decision and Deny answers the agent", async () => {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches: query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/activity");
  await userEvent.click(await screen.findByRole("button", { name: /Install @fontsource/ }));
  const request = await screen.findByRole("article", { name: "Install @fontsource/noto-sans-jp?" });
  expect(await within(request).findByText("bun add @fontsource/noto-sans-jp@5.1.0")).toBeTruthy();
  await userEvent.click(within(request).getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-refund-tax", "approve-font")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
});
