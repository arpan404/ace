import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const disclosureOf = (title: string) => {
  const details = screen.getByText(title, { selector: "summary" }).closest("details");
  if (!details) throw new Error(`${title} is not a disclosure`);
  return details;
};

test("a settings disclosure stays folded until opened, shows its rows, and folds again", async () => {
  await harness().open("/settings/general");
  await screen.findByText("Per-provider defaults", { selector: "summary" });
  expect(disclosureOf("Per-provider defaults").open).toBe(false);

  await userEvent.click(screen.getByText("Per-provider defaults", { selector: "summary" }));
  expect(disclosureOf("Per-provider defaults").open).toBe(true);
  expect(await screen.findByRole("combobox", { name: "Claude Code permissions" })).toBeTruthy();

  await userEvent.click(screen.getByText("Per-provider defaults", { selector: "summary" }));
  expect(disclosureOf("Per-provider defaults").open).toBe(false);
});

test("a link to a setting inside a disclosure opens it", async () => {
  await harness().open("/settings/general#permissions.providerModes");
  await screen.findByText("Per-provider defaults", { selector: "summary" });
  expect(disclosureOf("Per-provider defaults").open).toBe(true);
});

test("a group's explanation reads before its rows, inside the same titled section", async () => {
  await harness().open("/settings/storage");
  const retention = await screen.findByRole("region", { name: "Retention" });
  const explanation = within(retention).getByText(/^Days to keep archived threads/);
  const firstRow = await within(retention).findByText("Threads and transcripts");
  // Reading order: the explanation, then the rows it explains.
  expect(
    explanation.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The save action follows the rows it saves.
  const save = within(retention).getByRole("button", { name: "Save retention" });
  expect(firstRow.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a dialog opened from a settings card is its own surface, not a row of the card", async () => {
  const general = await harness().open("/settings/general");
  await screen.findByText("Per-provider defaults", { selector: "summary" });
  // On a card, a disclosure is one of the card's rows.
  expect(disclosureOf("Per-provider defaults").dataset.settingSurface).toBe("card");
  general.unmount();

  await harness().open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "+ Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  const advanced = (
    await within(dialog).findByText("Advanced access", { selector: "summary" })
  ).closest("details");
  // The pairing dialog opens from the Paired devices card, but its disclosure is a plain one.
  expect(advanced?.dataset.settingSurface).toBe("plain");
});

test("a link to an action row scrolls to it and flashes it, as for any setting", async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  onTestFinished(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  await harness().open("/settings/remote#remote.pair");
  const pair = await screen.findByRole("button", { name: "+ Pair a device" });
  await waitFor(() => expect(scrolled).toContain(pair));
  await waitFor(() => expect(pair.dataset.flash).toBe("true"));
  // The flash is a moment, not a state.
  await waitFor(() => expect(pair.dataset.flash).toBeUndefined(), { timeout: 3_000 });
});

test("a provider's model problem is said once, however many of its accounts report it", async () => {
  await harness().open("/settings/providers/opencode");
  const behaviour = await screen.findByRole("region", { name: "Behaviour" });
  const lines = await within(behaviour).findAllByText(/^OpenRouter could not be reached/);
  expect(lines).toHaveLength(1);
});

test("a cleanup preview that finds nothing says so, with no remove action", async () => {
  await harness().open("/settings/storage");
  await userEvent.click(await screen.findByRole("button", { name: "Preview cleanup" }));
  const preview = await screen.findByRole("region", { name: "Cleanup preview" });
  expect(await within(preview).findByText(/^Nothing to clean up/)).toBeTruthy();
  expect(within(preview).queryByRole("button", { name: /^Remove/ })).toBeNull();
});

test("an expired sign-in is said once on a provider's page, with the account's own action", async () => {
  await harness().open("/settings/providers/cursor");
  const accounts = await screen.findByRole("region", { name: "Accounts" });
  expect(await within(accounts).findByRole("button", { name: /Reconnect/ })).toBeTruthy();
  expect(await screen.findAllByText("Cursor sign-in has expired.")).toHaveLength(1);
  // The Behaviour card leaves signing in to the account row.
  const behaviour = await screen.findByRole("region", { name: "Behaviour" });
  expect(within(behaviour).queryByRole("button", { name: /^Sign in/ })).toBeNull();
});
