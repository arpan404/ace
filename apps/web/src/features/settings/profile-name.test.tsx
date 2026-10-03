import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the account button shows the initials of the name given in Settings", async () => {
  await harness().open("/settings/general");
  const account = await screen.findByRole("button", { name: "Account and connection" });
  expect(account.textContent).toBe("");

  const name = await screen.findByRole("textbox", { name: "Your name" });
  await userEvent.type(name, "Arpan Bhandari{Enter}");

  expect(account.textContent).toBe("AB");
});

test("the name is kept on this device across reloads", async () => {
  const app = harness();
  const first = await app.open("/settings/general");
  await userEvent.type(await screen.findByRole("textbox", { name: "Your name" }), "ada lovelace");
  await userEvent.tab();
  first.unmount();

  await harness({ storage: app.storage }).open("/settings/general");
  expect((await screen.findByRole("button", { name: "Account and connection" })).textContent).toBe(
    "AL",
  );
});
