import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const account = () => screen.findByRole("button", { name: "Account and connection" });

test("the account button shows the initials of the name given in Settings, and its menu the name", async () => {
  await harness().open("/settings/general");
  expect(within(await account()).queryByText("AB")).toBeNull();

  const name = await screen.findByRole("textbox", { name: "Your name" });
  await userEvent.type(name, "Arpan Bhandari{Enter}");

  expect(within(await account()).getByText("AB")).toBeTruthy();
  await userEvent.click(await account());
  expect(within(await screen.findByRole("menu")).getByText("Arpan Bhandari")).toBeTruthy();
});

test("the name is kept on this device across reloads", async () => {
  const app = harness();
  const first = await app.open("/settings/general");
  await userEvent.type(await screen.findByRole("textbox", { name: "Your name" }), "ada lovelace");
  await userEvent.tab();
  first.unmount();

  await harness({ storage: app.storage }).open("/settings/general");
  expect(within(await account()).getByText("AL")).toBeTruthy();
});
