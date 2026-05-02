import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PlanSummaryPanel } from "./PlanSummaryPanel";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "dark" as const,
    resolvedTheme: "dark" as const,
    setTheme: () => undefined,
  }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
}));

describe("PlanSummaryPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps long plan summaries scrollable", async () => {
    const screen = await render(
      <div style={{ display: "flex", height: "320px", width: "360px" }}>
        <PlanSummaryPanel
          activePlan={{
            createdAt: "2026-04-28T12:00:00.000Z",
            turnId: null,
            source: "plan-update",
            explanation:
              "Drive the work from the summary panel without losing the active todo list.",
            steps: Array.from({ length: 18 }, (_, index) => ({
              step: `Checklist item ${index + 1}: keep the side panel readable during long plan execution.`,
              status: index === 0 ? "inProgress" : index < 4 ? "completed" : "pending",
            })),
          }}
          activeProposedPlan={{
            id: "plan-scroll-browser-test",
            turnId: null,
            planMarkdown: [
              "# Long summary plan",
              "",
              ...Array.from(
                { length: 30 },
                (_, index) =>
                  `- Plan section ${index + 1}: make sure the right side panel can scroll through long content.`,
              ),
            ].join("\n"),
            createdAt: "2026-04-28T12:00:00.000Z",
            updatedAt: "2026-04-28T12:00:00.000Z",
            implementedAt: null,
            implementationThreadId: null,
          }}
          activeProvider="codex"
          markdownCwd={undefined}
          workspaceDiffSummary={null}
          workspaceRoot={undefined}
        />
      </div>,
    );

    try {
      const expandButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Open plan preview",
      ) as HTMLButtonElement | undefined;
      expect(expandButton).toBeTruthy();
      expandButton?.click();

      const scrollContainer = document.querySelector<HTMLElement>(
        '[data-plan-summary-scroll-container="true"]',
      );
      expect(scrollContainer).toBeTruthy();

      await vi.waitFor(
        () => {
          expect(scrollContainer?.scrollHeight ?? 0).toBeGreaterThan(
            scrollContainer?.clientHeight ?? 0,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      if (!scrollContainer) {
        throw new Error("Missing summary scroll container.");
      }

      scrollContainer.scrollTop = 240;
      scrollContainer.dispatchEvent(new Event("scroll"));

      await vi.waitFor(
        () => {
          expect(scrollContainer.scrollTop).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await screen.unmount();
    }
  });
});
