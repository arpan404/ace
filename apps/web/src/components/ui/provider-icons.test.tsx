import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ProviderIcon, ProviderIconTip } from "./provider-icons.tsx";

test("provider and ACP marks have the names a person expects", async () => {
  render(
    <>
      <ProviderIcon provider="codex" />
      <ProviderIcon provider="acp" acpAgentId="official:gemini" />
      <ProviderIcon provider="acp" acpAgentId="local:house-reviewer" />
    </>,
  );
  expect(await screen.findByRole("img", { name: "Codex" })).toBeTruthy();
  expect(await screen.findByRole("img", { name: "Gemini CLI" })).toBeTruthy();
  expect(await screen.findByRole("img", { name: "house-reviewer" })).toBeTruthy();
});

test("a decorative mark stays out of the accessibility tree", () => {
  render(
    <span>
      <ProviderIcon provider="pi" decorative />
      Pi
    </span>,
  );
  expect(screen.queryByRole("img")).toBeNull();
});

test("hovering a provider mark names it", async () => {
  render(<ProviderIconTip provider="opencode" />);
  await userEvent.hover(screen.getByRole("img", { name: "OpenCode" }));
  expect(await screen.findByText("OpenCode")).toBeTruthy();
});
