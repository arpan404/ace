import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { brandArt } from "@ace/ui-core/provider-icons";
import { ProviderTile } from "./provider-tile.tsx";

test.each([
  ["openai-codex", "ChatGPT / Codex", "openai"],
  ["google-gemini-cli", "Google Gemini CLI", "geminicli"],
  ["google-antigravity", "Google Antigravity", "antigravity"],
  ["github-copilot", "GitHub Copilot", "githubcopilot"],
  ["anthropic", "Claude", "claude"],
  ["openrouter", "OpenRouter", "openrouter"],
  ["moonshotai", "Moonshot AI", "kimi"],
  ["minimax-cn", "MiniMax China", "minimax"],
  ["google-vertex", "Google Vertex", "gemini"],
] as const)("%s has a service mark instead of a letter tile", async (id, label, brand) => {
  render(<ProviderTile provider="pi" service={{ id, label }} />);
  const icon = screen.getByRole("img", { name: label });
  const art = await brandArt[brand]();
  const path = (art.color ?? art.mono)[0]?.d;
  await waitFor(() => expect(icon.querySelector("path")?.getAttribute("d")).toBe(path));
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
