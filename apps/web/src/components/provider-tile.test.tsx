import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProviderTile } from "./provider-tile.tsx";

test.each([
  ["openai-codex", "ChatGPT / Codex"],
  ["google-gemini-cli", "Google Gemini CLI"],
  ["google-antigravity", "Google Antigravity"],
  ["github-copilot", "GitHub Copilot"],
  ["anthropic", "Claude"],
  ["openrouter", "OpenRouter"],
  ["moonshotai", "Moonshot AI"],
  ["minimax-cn", "MiniMax China"],
  ["google-vertex", "Google Vertex"],
] as const)("%s has a service mark instead of a letter tile", (id, label) => {
  render(<ProviderTile provider="pi" service={{ id, label }} />);
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
  expect(screen.queryByText(label.slice(0, 1))).toBeNull();
});
test("an unknown service keeps a readable initial", () => {
  render(
    <ProviderTile
      provider="opencode"
      service={{ id: "custom-model-host", label: "Custom host" }}
    />,
  );
  expect(screen.getByText("C")).toBeTruthy();
});
