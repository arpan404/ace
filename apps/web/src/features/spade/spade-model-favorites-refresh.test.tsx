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

interface StoredFavorite {
  machine: string;
  account: string;
  value: string;
}

const stored = (): StoredFavorite[] =>
  JSON.parse(localStorage.getItem(favoritesKey) ?? "[]") as StoredFavorite[];

const values = () => stored().map((favorite) => favorite.value);

test("a reopened picker reads storage again, and its writes keep another tab's changes", async () => {
  await spadeApp("/settings/spade/models", setup);
  const roles = within(await screen.findByRole("region", { name: "Roles" }));
  await userEvent.click(await roles.findByRole("button", { name: "Helpers" }));
  await userEvent.click(await screen.findByRole("button", { name: "Add Sonnet to favorites" }));
  await waitFor(() => expect(values()).toEqual(["openrouter/anthropic/sonnet"]));
  const machine = stored()[0]?.machine;
  if (!machine) throw new Error("Expected the favorite's machine");

  // Close every picker, then let another tab star Llama. No storage event reaches this tab.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull());
  localStorage.setItem(
    favoritesKey,
    JSON.stringify([
      ...stored(),
      { machine, account: "openrouter", value: "openrouter/meta/llama" },
    ]),
  );

  // Reopened, it shows the other tab's star rather than its cached list.
  await userEvent.click(await roles.findByRole("button", { name: "Helpers" }));
  const inherited = await screen.findByRole("button", { name: "Remove Llama from favorites" });
  expect(inherited.getAttribute("aria-pressed")).toBe("true");

  // A second change arrives while it is open; the next toggle still reads it before writing.
  localStorage.setItem(
    favoritesKey,
    JSON.stringify([
      ...stored(),
      { machine, account: "openrouter", value: "openrouter/saved/model" },
    ]),
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove Sonnet from favorites" }));
  await waitFor(() => expect(values()).toHaveLength(2));
  expect(values()).toEqual(
    expect.arrayContaining(["openrouter/meta/llama", "openrouter/saved/model"]),
  );
});
