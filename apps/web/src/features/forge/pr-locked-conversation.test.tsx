import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrConversationBox } from "./pr-conversation-box.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";
import { PrReplyField } from "./pr-thread.tsx";
import { reviewDetail, reviewHarness, reviewState } from "./review-harness.tsx";

const reason = "This conversation is locked. Only collaborators who can push can comment.";

// GitHub reports a conversation locked to the viewer as one they can't comment on.
const locked = (ui: ReactNode) =>
  reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ canComment: false }),
    commentsLocked: true,
    ui,
  });

test("a locked conversation keeps the Timeline comment box, off, with the reason", async () => {
  const f = await locked(<PrConversationBox />);
  try {
    const box = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
    expect(box.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Comment" }).disabled).toBe(true);
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a locked conversation's reply line says why instead of opening a reply", async () => {
  const f = await locked(<PrReplyField threadId="T1" rootCommentId={5} />);
  try {
    await screen.findByText(reason);
    expect(screen.queryByRole("button", { name: "Reply…" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  } finally {
    await f.close();
  }
});

test("on a locked conversation the Review popover opens but can't submit, and says why", async () => {
  const f = await locked(<PrReviewButton />);
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    const summary = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Review summary",
    });
    expect(summary.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Submit review" }).disabled).toBe(
      true,
    );
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test("without a lock the same account sees no comment box when GitHub says it can't comment", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ canComment: false }),
    ui: <PrConversationBox />,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(screen.queryByText(reason)).toBeNull();
  } finally {
    await f.close();
  }
});
