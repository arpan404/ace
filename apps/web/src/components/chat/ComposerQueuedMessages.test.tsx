import { MessageId } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { appendBrowserDesignContextToPrompt } from "../../lib/terminalContext";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";

describe("ComposerQueuedMessages", () => {
  it("renders a steering state for the active steering row with edit/delete actions and icon-only attachments", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          {
            id: MessageId.makeUnsafe("queued-1"),
            prompt: "Refine the layout spacing across the header and sidebar.",
            images: [{ id: "image-1" }, { id: "image-2" }],
            terminalContexts: [{ id: "terminal-1" }],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
        ]}
        steerMessageId={MessageId.makeUnsafe("queued-1")}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Steering message"');
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain(">Steering</button>");
    expect(markup).not.toContain('aria-label="Steer queued message"');
    expect(markup).toContain('aria-label="Edit queued message"');
    expect(markup).toContain('aria-label="Delete queued message"');
    expect(markup).not.toContain("2 images");
    expect(markup).not.toContain("1 terminal");
  });

  it("hides steer actions from other rows while a steering request is active", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          {
            id: MessageId.makeUnsafe("queued-1"),
            prompt: "Steer this next.",
            images: [],
            terminalContexts: [],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
          {
            id: MessageId.makeUnsafe("queued-2"),
            prompt: "Keep this in the normal queue.",
            images: [],
            terminalContexts: [],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
        ]}
        steerMessageId={MessageId.makeUnsafe("queued-1")}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Steering message"');
    expect(markup).not.toContain('aria-label="Steer queued message"');
    expect(markup).toContain("Keep this in the normal queue.");
  });

  it("shows send instead of steering when queued messages can be sent after interruption", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          {
            id: MessageId.makeUnsafe("queued-1"),
            prompt: "Send this after the interrupted turn.",
            images: [],
            terminalContexts: [],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
        ]}
        canSendNow
        steerMessageId={MessageId.makeUnsafe("queued-1")}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn()}
        onSend={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Send queued message"');
    expect(markup).toContain(">Send</button>");
    expect(markup).not.toContain("Steering");
    expect(markup).not.toContain('aria-label="Steer queued message"');
  });

  it("renders steer and edit controls for designer queue rows", () => {
    const prompt = appendBrowserDesignContextToPrompt("Tighten the card rhythm", {
      requestId: "DR-4F2C8A11",
      pageUrl: "https://example.com/dashboard",
      pagePath: "/dashboard",
      selection: { x: 24, y: 40, width: 360, height: 180 },
      targetElement: null,
      mainContainer: null,
    });

    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          {
            id: MessageId.makeUnsafe("queued-design"),
            prompt,
            images: [],
            terminalContexts: [],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
        ]}
        steerMessageId={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Steer queued message"');
    expect(markup).toContain('aria-label="Edit queued message"');
    expect(markup).toContain("Tighten the card rhythm");
    expect(markup).not.toContain("browser_design_context");
    expect(markup).not.toContain("DR-4F2C8A11");
  });

  it("renders an active goal as a queue row when there are no queued messages", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        activeGoal={{
          createdAt: "2026-06-05T00:00:00.000Z",
          objective: "Audit the codebase in /repo/apps/server",
          status: "active",
          threadId: "thread-1",
          tokensUsed: 23275,
        }}
        messages={[]}
        steerMessageId={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn()}
        onDeleteGoal={vi.fn()}
        onEditGoal={vi.fn()}
        onPauseGoal={vi.fn()}
        onResumeGoal={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain(">1</span>");
    expect(markup).toContain(">Goal</span>");
    expect(markup).toContain("Audit the codebase in /repo/apps/server");
    expect(markup).toContain("23,275 tokens");
    expect(markup).toContain('aria-label="Pause goal"');
    expect(markup).toContain('aria-label="Edit goal"');
    expect(markup).toContain('aria-label="Delete goal"');
    expect(markup).not.toContain("Clear all");
  });

  it("renders nothing when the queue is empty", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[]}
        steerMessageId={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toBe("");
  });
});
