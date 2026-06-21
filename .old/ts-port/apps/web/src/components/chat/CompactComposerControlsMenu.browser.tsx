import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";

async function mountMenu(props?: {
  interactionMode?: "default" | "plan";
  interactionModeDisabledReason?: string | null;
  onPickImages?: () => void;
  onSelectProviderCommand?: (command: string) => void;
  onToggleInteractionMode?: () => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <CompactComposerControlsMenu
      interactionMode={props?.interactionMode ?? "default"}
      interactionModeDisabledReason={props?.interactionModeDisabledReason ?? null}
      skillCommands={[
        {
          id: "skill:frontend-design",
          command: "frontend-design",
          label: "frontend-design",
          description: "Design frontend UI",
        },
      ]}
      pluginCommands={[
        {
          id: "plugin:browser",
          command: "browser",
          label: "browser",
          description: "Use browser tools",
        },
      ]}
      onPickImages={props?.onPickImages ?? vi.fn()}
      onSelectProviderCommand={props?.onSelectProviderCommand ?? vi.fn()}
      onToggleInteractionMode={props?.onToggleInteractionMode ?? vi.fn()}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("CompactComposerControlsMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the compact attachment and plan controls without helper jargon", async () => {
    await using _ = await mountMenu();

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Add photos & files");
      expect(text).toContain("Plan mode");
      expect(text).toContain("Skills");
      expect(text).toContain("Plugins");
      expect(text).not.toContain("Actions");
      expect(text).not.toContain("Drop images here");
    });
  });

  it("runs the picker action from the menu", async () => {
    const onPickImages = vi.fn();
    await using _ = await mountMenu({ onPickImages });

    await page.getByLabelText("More composer controls").click();
    await page.getByText("Add photos & files").click();

    expect(onPickImages).toHaveBeenCalledTimes(1);
  });

  it("toggles plan from the compact switch row", async () => {
    const onToggleInteractionMode = vi.fn();
    await using _ = await mountMenu({ onToggleInteractionMode });

    await page.getByLabelText("More composer controls").click();
    await page.getByText("Plan mode").click();

    expect(onToggleInteractionMode).toHaveBeenCalledTimes(1);
  });

  it("opens the skill command submenu", async () => {
    await using _ = await mountMenu();

    await page.getByLabelText("More composer controls").click();
    await page.getByText("Skills").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("1 skill");
      expect(text).toContain("frontend-design");
      expect(text).not.toContain("Design frontend UI");
    });
  });

  it("selects a skill command from the submenu", async () => {
    const onSelectProviderCommand = vi.fn();
    await using _ = await mountMenu({ onSelectProviderCommand });

    await page.getByLabelText("More composer controls").click();
    await page.getByText("Skills").click();
    await page.getByText("frontend-design").click();

    expect(onSelectProviderCommand).toHaveBeenCalledWith("frontend-design");
  });

  it("opens the plugin command submenu", async () => {
    await using _ = await mountMenu();

    await page.getByLabelText("More composer controls").click();
    await page.getByText("Plugins").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("1 plugin");
      expect(text).toContain("browser");
      expect(text).not.toContain("Use browser tools");
    });
  });
});
