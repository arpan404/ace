import { expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeComment } from "@ace/protocol";
import { PrAttention } from "./pr-attention.tsx";
import { PrComment } from "./pr-comment.tsx";
import { PrConversationBox } from "./pr-conversation-box.tsx";
import { PrThread } from "./pr-thread.tsx";
import { inlineComment, reviewDetail, reviewHarness, reviewState } from "./review-harness.tsx";

const issue = (id: number, body: string, author = "ola") =>
  ForgeComment.parse({
    kind: "issue",
    id,
    author,
    body,
    file: null,
    line: null,
    updatedAt: "2026-10-10T10:00:00Z",
    replyTo: null,
  });
const thread = (resolved = false) => ({
  id: "T1",
  resolved,
  outdated: false,
  file: "src/main.ts",
  line: 7,
  side: "RIGHT" as const,
  comments: [inlineComment(5, "Rename this?", "ola"), inlineComment(6, "Done.", "reviewer")],
});

const menuOf = async (author: string, index = 0) =>
  userEvent.click(
    (await screen.findAllByRole("button", { name: `Actions for ${author}'s comment` }))[index]!,
  );

test("Quote reply sends a conversation comment's text, quoted, to the comment box", async () => {
  let opened = 0;
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState(),
    onConversation: () => opened++,
    ui: (
      <>
        <PrComment
          comment={issue(9, "Ship it\nafter the docs")}
          quoteTarget="conversation"
          open={false}
          onToggle={() => {}}
        />
        <PrConversationBox />
      </>
    ),
  });
  try {
    const box = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
    await userEvent.type(box, "Earlier thought");
    await menuOf("ola");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Quote reply" }));
    await waitFor(() =>
      expect(box.value).toBe("Earlier thought\n\n> Ship it\n> after the docs\n\n"),
    );
    // The box lives in the Timeline: quoting asks for it to be shown.
    expect(opened).toBe(1);
  } finally {
    await f.close();
  }
});

test("Quote reply on a review comment opens that conversation's reply with the quote", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState(),
    ui: <PrThread thread={thread()} />,
  });
  try {
    await menuOf("ola");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Quote reply" }));
    const reply = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });
    expect(reply.value).toBe("> Rename this?\n\n");
    await userEvent.type(reply, "Renamed.");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    // GitHub takes replies on the conversation's first comment.
    await waitFor(() =>
      expect(f.sent).toEqual([{ kind: "reply", commentId: 5, body: "> Rename this?\n\nRenamed." }]),
    );
  } finally {
    await f.close();
  }
});

test("a hidden comment folds to its reason until shown, and the viewer can unhide or hide it", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({
      hidden: [{ source: "issue", commentId: 9, reason: "OUTDATED" }],
      hideable: [
        { source: "issue", commentId: 9 },
        { source: "issue", commentId: 10 },
      ],
    }),
    ui: (
      <>
        <PrComment comment={issue(9, "Old port numbers")} open={false} onToggle={() => {}} />
        <PrComment comment={issue(10, "Off topic", "sam")} open={false} onToggle={() => {}} />
      </>
    ),
  });
  try {
    await screen.findByText("Hidden as outdated");
    expect(screen.queryByText("Old port numbers")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    screen.getByText("Old port numbers");
    await menuOf("ola");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Unhide" }));
    await menuOf("sam");
    expect(screen.queryByRole("menuitem", { name: "Unhide" })).toBeNull();
    await userEvent.hover(await screen.findByRole("menuitem", { name: "Hide" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Off-topic" }));
    await waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent).toEqual([
      { kind: "comment.unhide", source: "issue", commentId: 9 },
      { kind: "comment.hide", source: "issue", commentId: 10, reason: "off-topic" },
    ]);
  } finally {
    await f.close();
  }
});

test("a comment GitHub won't let the viewer hide offers no Hide", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ hideable: [] }),
    ui: <PrComment comment={issue(9, "Text")} open={false} onToggle={() => {}} />,
  });
  try {
    await menuOf("ola");
    await screen.findByRole("menuitem", { name: "Copy link" });
    expect(screen.queryByRole("menuitem", { name: "Hide" })).toBeNull();
  } finally {
    await f.close();
  }
});

test("a resolved conversation starts folded; resolving one sends it to GitHub", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ resolvableThreads: ["T1"] }),
    ui: <PrThread thread={thread(true)} place />,
  });
  try {
    const fold = await screen.findByRole("button", { expanded: false });
    within(fold).getByText("Resolved");
    within(fold).getByText("2 comments");
    expect(screen.queryByText("Done.")).toBeNull();
    f.rerender(<PrThread thread={thread(false)} place />);
    // Reopened on GitHub, it unfolds.
    await screen.findByText("Done.");
    await userEvent.click(await screen.findByRole("button", { name: "Resolve conversation" }));
    await waitFor(() => expect(f.sent).toEqual([{ kind: "thread.resolve", threadId: "T1" }]));
  } finally {
    await f.close();
  }
});

test("a review comment that needs attention can be answered from its row", async () => {
  const detail = reviewDetail({ reviewThreads: [thread()] });
  const f = await reviewHarness({
    detail,
    state: reviewState(),
    ui: <PrAttention workspaceId="api" detail={detail} disabled={false} />,
  });
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Reply: Rename this?" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Reply" }), "On it");
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(f.sent).toEqual([{ kind: "reply", commentId: 5, body: "On it" }]));
    // Sent, the reply field folds away again.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull());
  } finally {
    await f.close();
  }
});

const shown = (on: boolean) => (on ? <PrThread thread={thread()} /> : <p>Scrolled away</p>);

test("an edit and an open reply survive their row scrolling away and back, which takes no focus", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState(),
    ui: shown(true),
  });
  try {
    await menuOf("reviewer");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const edit = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" });
    // Asked for by the person, focus arrives.
    await waitFor(() => expect(document.activeElement).toBe(edit));
    await userEvent.type(edit, " Renamed both.");
    await userEvent.click(screen.getByRole("button", { name: "Reply…" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Reply" }), "Thanks");
    // A long list unmounts rows off screen, then mounts them again.
    f.rerender(shown(false));
    await screen.findByText("Scrolled away");
    f.rerender(shown(true));
    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" })).value,
    ).toBe("Done. Renamed both.");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" }).value).toBe(
      "Thanks",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  } finally {
    await f.close();
  }
});

test("a hidden comment's text never shows: its conversation folds to 'Hidden comment', and it needs no attention", async () => {
  const hiddenFirst = { ...thread(true), resolved: false };
  const detail = reviewDetail({ reviewThreads: [hiddenFirst] });
  const state = reviewState({ hidden: [{ source: "inline", commentId: 5, reason: "spam" }] });
  const f = await reviewHarness({
    detail,
    state,
    ui: (
      <>
        <PrThread thread={{ ...hiddenFirst, resolved: true }} place />
        <PrAttention workspaceId="api" detail={detail} disabled={false} />
      </>
    ),
  });
  try {
    await screen.findByText("Hidden comment");
    expect(screen.queryByText(/Rename this\?/)).toBeNull();
    // Nothing of it reaches Needs attention, nor so any agent's request.
    expect(screen.queryByRole("button", { name: /Fix with agent/ })).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  } finally {
    await f.close();
  }
});

test("Quote reply isn't offered where the viewer can't comment", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ canComment: false }),
    ui: <PrThread thread={thread()} />,
  });
  try {
    await menuOf("ola");
    await screen.findByRole("menuitem", { name: "Copy link" });
    expect(screen.queryByRole("menuitem", { name: "Quote reply" })).toBeNull();
  } finally {
    await f.close();
  }
});

test("Needs attention keeps its own reply, and quote replies go to the conversation's", async () => {
  const detail = reviewDetail({ reviewThreads: [thread()] });
  const f = await reviewHarness({
    detail,
    state: reviewState(),
    ui: (
      <>
        <PrAttention workspaceId="api" detail={detail} disabled={false} />
        <PrThread thread={thread()} />
      </>
    ),
  });
  try {
    await userEvent.click(await screen.findByRole("button", { name: "Reply: Rename this?" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Reply" }), "From the row");
    await menuOf("ola");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Quote reply" }));
    const replies = await screen.findAllByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });
    expect(replies.map((reply) => reply.value)).toEqual(["From the row", "> Rename this?\n\n"]);
  } finally {
    await f.close();
  }
});

const resolvedShown = (on: boolean) =>
  on ? <PrThread thread={thread(true)} /> : <p>Scrolled away</p>;

test("a resolved conversation the person opened stays open when its row comes back", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState(),
    ui: resolvedShown(true),
  });
  try {
    await userEvent.click(await screen.findByRole("button", { expanded: false }));
    await menuOf("reviewer");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Edit comment" }),
      " Also the docs.",
    );
    f.rerender(resolvedShown(false));
    await screen.findByText("Scrolled away");
    f.rerender(resolvedShown(true));
    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" })).value,
    ).toBe("Done. Also the docs.");
  } finally {
    await f.close();
  }
});

test("until GitHub says which comments are hidden, Needs attention shows no comment text and can't send it to an agent", async () => {
  for (const hidden of [undefined, null]) {
    const detail = reviewDetail({ reviewThreads: [thread()] });
    const f = await reviewHarness({
      detail,
      state: reviewState({ hidden }),
      ui: <PrAttention workspaceId="api" detail={detail} disabled={false} />,
    });
    try {
      await screen.findByText("Review comment");
      expect(screen.queryByText(/Rename this\?/)).toBeNull();
      const fix = screen.getByRole<HTMLButtonElement>("button", {
        name: "Fix with agent: Review comment on src/main.ts:7",
      });
      expect(fix.disabled).toBe(true);
    } finally {
      await f.close();
    }
  }
});
