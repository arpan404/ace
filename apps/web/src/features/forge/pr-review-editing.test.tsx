import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileDiff } from "@ace/ui-core";
import { PrConversationBox } from "./pr-conversation-box.tsx";
import { PrLineComposer } from "./pr-line-composer.tsx";
import { PrReviewButton } from "./pr-review-popover.tsx";
import { PrReplyField } from "./pr-thread.tsx";
import { headSha, reviewDetail, reviewHarness, reviewState } from "./review-harness.tsx";

const diff: FileDiff = {
  path: "src/main.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  rows: [
    { kind: "context", old: 1, new: 1, text: "import x" },
    { kind: "del", old: 2, text: "const a = 1;" },
    { kind: "add", new: 2, text: "const a = 2;" },
    { kind: "add", new: 3, text: "const b = 3;" },
  ],
};
const draft = {
  id: "d1",
  body: "Pending one",
  anchor: { commit: headSha, path: "src/main.ts", line: 3, side: "RIGHT" as const },
};

const lineComposer = (
  <PrLineComposer
    path="src/main.ts"
    diff={diff}
    range={{ side: "new", start: 2, end: 3 }}
    headSha={headSha}
    onClose={() => {}}
  />
);

/** Each place text is written, how it opens, and the action its main button sends. */
const boxes: {
  name: string;
  ui: ReactNode;
  open?: () => Promise<void>;
  field: string;
  button: string;
  sent: object;
}[] = [
  {
    name: "the Timeline's comment box",
    ui: <PrConversationBox />,
    field: "Comment",
    button: "Comment",
    sent: { kind: "conversation", body: "Submitted A" },
  },
  {
    name: "a review thread's reply",
    ui: <PrReplyField threadId="T1" rootCommentId={5} />,
    open: async () => {
      await userEvent.click(await screen.findByRole("button", { name: "Reply…" }));
    },
    field: "Reply",
    button: "Reply",
    sent: { kind: "reply", commentId: 5, body: "Submitted A" },
  },
  {
    name: "a line comment starting a review",
    ui: lineComposer,
    field: "Line comment",
    button: "Start a review",
    sent: { kind: "draft.save", draft: { body: "Submitted A" } },
  },
  {
    name: "the review's summary",
    ui: <PrReviewButton />,
    open: async () => {
      await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    },
    field: "Review summary",
    button: "Submit review",
    sent: { kind: "submit", event: "COMMENT", body: "Submitted A", draftIds: [] },
  },
];

for (const box of boxes)
  test.each(["edited", "unchanged"] as const)(
    `${box.name} keeps text typed while it posted and clears what was posted: %s`,
    async (change) => {
      const f = await reviewHarness({ detail: reviewDetail(), state: reviewState(), ui: box.ui });
      try {
        await box.open?.();
        const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: box.field });
        await userEvent.type(field, "Submitted A");
        const button = screen.getByRole<HTMLButtonElement>("button", { name: box.button });
        await waitFor(() => expect(button.disabled).toBe(false));
        f.hold();
        await userEvent.click(button);
        await waitFor(() => expect(f.sent).toHaveLength(1));
        if (change === "edited") {
          await userEvent.clear(field);
          await userEvent.type(field, "Unpublished B");
        }
        await act(async () => f.release());
        expect(f.sent[0]).toMatchObject(box.sent);
        await waitFor(() => {
          const now = screen.queryByRole<HTMLTextAreaElement>("textbox", { name: box.field });
          if (change === "edited") expect(now?.value).toBe("Unpublished B");
          // Posted, the box empties (or folds away, for a reply, a line comment or a review).
          else expect(now === null || now.value === "").toBe(true);
        });
      } finally {
        await f.close();
      }
    },
  );

test("a single line comment posts only itself, on the lines picked", async () => {
  const f = await reviewHarness({ detail: reviewDetail(), state: reviewState(), ui: lineComposer });
  try {
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Line comment" }),
      "Rename these",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add single comment" }));
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent).toEqual([
      {
        kind: "line.comment",
        headSha,
        body: "Rename these",
        anchor: {
          commit: headSha,
          path: "src/main.ts",
          line: 3,
          side: "RIGHT",
          startLine: 2,
          startSide: "RIGHT",
        },
      },
    ]);
  } finally {
    await f.close();
  }
});

test("with comments pending, a line comment joins the review and can't post on its own", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ drafts: [draft] }),
    ui: lineComposer,
  });
  try {
    const add = await screen.findByRole("button", { name: "Add review comment" });
    expect(screen.queryByRole("button", { name: "Add single comment" })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "Line comment" }), "Also this");
    await userEvent.click(add);
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]).toMatchObject({ kind: "draft.save", draft: { body: "Also this" } });
  } finally {
    await f.close();
  }
});

test("Suggest changes starts a suggestion from the picked lines as they read now", async () => {
  const f = await reviewHarness({ detail: reviewDetail(), state: reviewState(), ui: lineComposer });
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Suggest changes" }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Line comment" }).value).toBe(
      "```suggestion\nconst a = 2;\nconst b = 3;\n```\n",
    );
  } finally {
    await f.close();
  }
});

test("the review sends every pending comment with the verdict, and approval waits on someone else's PR", async () => {
  const own = await reviewHarness({
    detail: reviewDetail({}, "reviewer"),
    state: reviewState({ drafts: [draft], canReview: false }),
    ui: <PrReviewButton />,
  });
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Review · 1 pending" }));
    expect(screen.getByRole("radio", { name: "Approve" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    screen.getByText("You can't approve or request changes on your own pull request.");
  } finally {
    await own.close();
  }
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ drafts: [draft] }),
    ui: <PrReviewButton />,
  });
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Review · 1 pending" }));
    screen.getByText("Pending one");
    await userEvent.click(screen.getByRole("radio", { name: "Request changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]).toEqual({
      kind: "submit",
      event: "REQUEST_CHANGES",
      body: "",
      headSha,
      draftIds: ["d1"],
    });
  } finally {
    await f.close();
  }
});

test("an uncertain review keeps its summary and offers to reconcile", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState(),
    ui: <PrReviewButton />,
  });
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    const summary = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Review summary" });
    await userEvent.type(summary, "Keep my review");
    f.loseTrack();
    await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
    expect(
      await screen.findByText(
        /The daemon lost track of the result: check the checkout or GitHub before retrying/,
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Reconcile write" })).toBeTruthy();
    expect(summary.value).toBe("Keep my review");
  } finally {
    await f.close();
  }
});
