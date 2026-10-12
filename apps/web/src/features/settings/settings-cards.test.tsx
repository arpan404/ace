import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
