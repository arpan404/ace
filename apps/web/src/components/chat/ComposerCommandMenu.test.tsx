import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders the Ace-native side chat slash command", () => {
    const html = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:side",
            type: "slash-command",
            command: "side",
            commandSource: "ace",
            label: "/side",
            description: "Open a side chat composer",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:side"
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("/side");
    expect(html).toContain("Open a side chat composer");
  });

  it("groups provider agent commands separately", () => {
    const html = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "provider-slash:agent:security-auditor",
            type: "provider-command",
            command: "security-auditor",
            commandKind: "agent",
            label: "Security Auditor",
            description: "Agent - <prompt>",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="provider-slash:agent:security-auditor"
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("Agents");
    expect(html).toContain("Security Auditor");
    expect(html).toContain("Agent");
  });

  it("renders provider command metadata badges", () => {
    const html = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "provider-slash:skill:claude-project",
            type: "provider-command",
            command: "claude-project",
            commandKind: "skill",
            label: "Claude Project",
            description: "Skill - [target] [format]",
            metadataBadges: ["sonnet", "2 tools"],
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="provider-slash:skill:claude-project"
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("Claude Project");
    expect(html).toContain("sonnet");
    expect(html).toContain("2 tools");
  });

  it("uses a generic empty state for slash commands", () => {
    const html = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("No matching command.");
    expect(html).not.toContain("No matching skill or plugin command.");
  });
});
