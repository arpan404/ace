import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The profile at the foot of the sidebar, named by the person's name ("You" until given). */
const account = () => screen.findByRole("button", { name: /, account/ });

test("the profile shows the name given in Settings and its initials, and its menu the name", async () => {
  await harness().open("/new");
  expect((await account()).getAttribute("aria-label")).toBe("You, account");
  expect(within(await account()).queryByText("AB")).toBeNull();

  await userEvent.click(screen.getByRole("link", { name: "Settings" }));
  const name = await screen.findByRole("textbox", { name: "Your name" });
  await userEvent.type(name, "Arpan Bhandari{Enter}");
  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));

  expect(within(await account()).getByText("AB")).toBeTruthy();
  expect(within(await account()).getByText("Arpan Bhandari")).toBeTruthy();
  expect((await account()).getAttribute("aria-label")).toBe("Arpan Bhandari, account");
  await userEvent.click(await account());
  expect(within(await screen.findByRole("menu")).getByText("Arpan Bhandari")).toBeTruthy();
});

test("the name is kept on this device across reloads", async () => {
  const app = harness();
  const first = await app.open("/settings/general");
  await userEvent.type(await screen.findByRole("textbox", { name: "Your name" }), "ada lovelace");
  await userEvent.tab();
  first.unmount();

  await harness({ storage: app.storage }).open("/new");
  expect(within(await account()).getByText("AL")).toBeTruthy();
});
