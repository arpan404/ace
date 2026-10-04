import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ProviderIcon, ProviderIconTip } from "./provider-icons.tsx";

test("a provider icon names the provider and draws its mark once loaded", async () => {
  render(<ProviderIcon provider="codex" size={16} />);
  const icon = await screen.findByRole("img", { name: "Codex" });
  expect(icon.getAttribute("width")).toBe("16");
  await waitFor(() => expect(icon.querySelector("path")).not.toBeNull());
});

test("an ACP agent's icon is named by its registry name", async () => {
  render(<ProviderIcon provider="acp" acpAgentId="official:gemini" />);
  expect(await screen.findByRole("img", { name: "Gemini CLI" })).toBeTruthy();
});

test("an agent without a brand draws the neutral glyph rather than nothing", async () => {
  render(<ProviderIcon provider="acp" acpAgentId="local:house-reviewer" />);
  const icon = screen.getByRole("img", { name: "house-reviewer" });
  await waitFor(() => expect(icon.querySelector("circle")).not.toBeNull());
});

test("a decorative icon beside its provider's name stays out of the accessibility tree", () => {
  render(
    <span>
      <ProviderIcon provider="pi" decorative /> Pi
    </span>,
  );
  expect(screen.queryByRole("img")).toBeNull();
});

test("the tip names the provider on hover", async () => {
  render(<ProviderIconTip provider="pi" />);
  await userEvent.hover(screen.getByRole("img", { name: "Pi" }));
  expect(await screen.findByText("Pi")).toBeTruthy();
});
