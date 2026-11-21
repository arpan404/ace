import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Picks `option` from the picker named `picker`. */
async function choose(picker: string, option: RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: picker }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a role's route takes fallbacks in order, at most four, and each change saves the list", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (here) => {
    withEndpoint(here);
    here.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  const roles = within(await screen.findByRole("region", { name: "Models for other work" }));
  await choose("Helpers", /^Sonnet/);
  await roles.findByRole("button", { name: "Add a fallback" });
  await userEvent.click(roles.getByRole("button", { name: "Add a fallback" }));
  await choose("Helpers, a new fallback", /^Llama/);
  await userEvent.click(await roles.findByRole("button", { name: "Add a fallback" }));
  await choose("Helpers, a new fallback", /^Saved model/);
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/models/roles").at(-1)).toEqual({
      roles: {
        helper: ["openrouter/anthropic/sonnet", "openrouter/meta/llama", "openrouter/saved/model"],
      },
    }),
  );
  // The second model goes; the rest keep their order.
  await userEvent.click(roles.getByRole("button", { name: "Remove Helpers, fallback 1" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/models/roles").at(-1)).toEqual({
      roles: { helper: ["openrouter/anthropic/sonnet", "openrouter/saved/model"] },
    }),
  );
  expect(roles.getByRole("button", { name: "Helpers, fallback 1" }).textContent).toContain(
    "Saved model",
  );
});

test("a route offers no subscription, and a full one takes no more", async () => {
  await spadeApp("/settings/spade/models", (here) => {
    withEndpoint(here);
    here.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    here.roles.global.helper = "openrouter/anthropic/sonnet";
    here.roles.globalRoutes = {
      helper: [
        "openrouter/anthropic/sonnet",
        "openrouter/meta/llama",
        "openrouter/saved/model",
        "openrouter/other/one",
      ],
    };
  });
  const row = await screen.findByRole("button", { name: "Helpers, fallback 3" });
  expect(row).toBeTruthy();
  const roles = within(screen.getByRole("region", { name: "Models for other work" }));
  // Only the rows without a full route offer to add one: Bots' fallbacks has none set.
  expect(roles.queryAllByRole("button", { name: "Add a fallback" })).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Helpers" }));
  expect(screen.queryByText("Your coding subscriptions")).toBeNull();
});
