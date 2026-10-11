import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("source control explains a chosen account mismatch and lets the person recover by rescanning", async () => {
  const app = harness({ throughWorker: true });
  await app.open("/settings/source-control");
  expect(await screen.findByText(/GitHub API access verified as ada/)).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "octo");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByText(/gh auth switch --hostname github.com --user octo/)).toBeTruthy();
  await userEvent.clear(screen.getByRole("textbox", { name: "Expected account" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "ada");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByText(/GitHub API access verified as ada/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
  expect(await screen.findByText(/GitHub API access verified as ada/)).toBeTruthy();
  expect(screen.getByText(/API sign-in does not verify Git clone/)).toBeTruthy();
});
