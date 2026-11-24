import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const favoritesKey = "ace.spade.models.favorites";

const setup = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

test("favorites saved by the old picker still show as stars", async () => {
  // The old picker stored plain endpoint/model strings under the same browser-wide key.
  localStorage.setItem(favoritesKey, JSON.stringify(["openrouter/anthropic/sonnet"]));
  await spadeApp("/settings/spade/models", setup);
  const roles = within(await screen.findByRole("region", { name: "Roles" }));
  await userEvent.click(await roles.findByRole("button", { name: "Helpers" }));
  const star = await screen.findByRole("button", { name: "Remove Sonnet from favorites" });
  expect(star.getAttribute("aria-pressed")).toBe("true");
  // Reading it now names the machine and account, so it is stored as a record.
  await waitFor(() => {
    const [saved] = JSON.parse(localStorage.getItem(favoritesKey) ?? "[]") as {
      machine: string;
      account: string;
      value: string;
    }[];
    expect(saved).toMatchObject({ account: "openrouter", value: "openrouter/anthropic/sonnet" });
    expect(saved?.machine).toBeTruthy();
  });
});
