import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { AccessMode } from "@ace/protocol";
import { accessChoices, threadAccessSummary } from "@ace/ui-core";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { PermissionPicker } from "./permission-picker.tsx";

configure({ asyncUtilTimeout: 10_000 });

/** What each provider reports it supports, as the daemon publishes it. */
const tables: Record<"claude" | "opencode" | "cursor", AccessMode[]> = {
  claude: ["read-only", "ask", "auto-review", "full-access"],
  opencode: ["read-only", "ask", "full-access"],
  cursor: ["auto-review", "full-access"],
};

function picker(
  provider: "claude" | "opencode" | "cursor",
  effective: AccessMode,
  wanted?: AccessMode,
) {
  const offers = tables[provider].map((mode) => ({ mode, native: `${provider}:${mode}` }));
  const selected: AccessMode[] = [];
  render(
    <TooltipProvider delay={0}>
      <PermissionPicker
        summary={threadAccessSummary({ override: null, effective, pending: false }, offers, {
          ...(wanted ? { defaultMode: wanted } : {}),
          provider: provider === "opencode" ? "OpenCode" : provider,
        })}
        menu={{ choices: accessChoices(offers), value: effective, loading: false }}
        onChange={(mode) => selected.push(mode)}
      />
    </TooltipProvider>,
  );
  return selected;
}

test("the chip lists the four modes with their one-line descriptions and picks one", async () => {
  const selected = picker("claude", "auto-review");
  await userEvent.click(screen.getByRole("button", { name: "Access: Auto review" }));
  const items = await screen.findAllByRole("menuitemradio");
  expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
    "Read-only",
    "Ask",
    "Auto review",
    "Full access",
  ]);
  expect(screen.getByText("Asks before edits and commands.")).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Ask" }));
  expect(selected).toEqual(["ask"]);
});

test("a provider's unsupported modes are hidden, not greyed out", async () => {
  picker("opencode", "ask");
  await userEvent.click(screen.getByRole("button", { name: "Access: Ask" }));
  const items = await screen.findAllByRole("menuitemradio");
  expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
    "Read-only",
    "Ask",
    "Full access",
  ]);
});

test("a default that ran stricter says so on the chip's tooltip only", async () => {
  picker("opencode", "ask", "auto-review");
  const trigger = screen.getByRole("button", { name: "Access: Ask" });
  await userEvent.hover(trigger);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "Auto review isn't available for OpenCode",
  );
  await userEvent.click(trigger);
  await screen.findAllByRole("menuitemradio");
  expect(screen.queryByText(/isn't available/)).toBeNull();
});
