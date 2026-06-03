import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders provider-native slash commands", () => {
    const html = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "provider-slash:provider:side",
            type: "provider-command",
            command: "side",
            commandKind: "provider",
            label: "/side",
            description: "Start an ephemeral side conversation - <prompt>",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="provider-slash:provider:side"
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("/side");
    expect(html).toContain("Start an ephemeral side conversation");
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
