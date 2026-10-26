import { expect, test } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeComment } from "@ace/protocol";
import { PrComment } from "./pr-comment.tsx";
import { reviewDetail, reviewHarness, reviewState } from "./review-harness.tsx";

const commentOf = (body: string, kind: "issue" | "inline") =>
  ForgeComment.parse({
    kind,
    id: 7,
    author: "reviewer",
    body,
    file: null,
    line: null,
    updatedAt: "2026-10-10",
    replyTo: null,
  });
const row = (body: string, kind: "issue" | "inline" = "issue") => (
  <PrComment key={7} comment={commentOf(body, kind)} open={false} onToggle={() => {}} />
);

async function commentEditor(body: string, kind: "issue" | "inline" = "issue") {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState(),
    ui: row(body, kind),
  });
  return { ...f, refresh: (text: string) => f.rerender(row(text, kind)) };
}

async function startEdit() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Actions for reviewer's comment" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" });
}

test("beginning an edit after refresh takes the current text and guard together", async () => {
  const f = await commentEditor("Original A");
  try {
    f.refresh("External B");
    expect((await startEdit()).value).toBe("External B");
    await userEvent.click(screen.getByRole("button", { name: "Update comment" }));
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent).toEqual([
      {
        kind: "comment.edit",
        source: "issue",
        commentId: 7,
        body: "External B",
        expectedBody: "External B",
      },
    ]);
    // Accepted, the comment reads as text again.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull());
  } finally {
    await f.close();
  }
});

test("a refresh during an edit retains its original guard and reports conflict without losing the draft", async () => {
  const f = await commentEditor("Original A");
  try {
    // The first refresh precedes Edit; this is the version the person begins editing.
    f.refresh("External B");
    const field = await startEdit();
    await userEvent.type(field, " edited locally");
    // Another device writes again during the edit, and refresh must not advance its guard.
    f.refresh("External C");
    f.refuse("forge_conflict");
    await userEvent.click(screen.getByRole("button", { name: "Update comment" }));
    await screen.findByText(
      "This changed on GitHub since you looked, or its name is taken: refresh, then retry.",
    );
    expect(f.sent).toEqual([
      {
        kind: "comment.edit",
        source: "issue",
        commentId: 7,
        body: "External B edited locally",
        expectedBody: "External B",
      },
    ]);
    expect(field.value).toBe("External B edited locally");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((await startEdit()).value).toBe("External C");
  } finally {
    await f.close();
  }
});

for (const kind of ["issue", "inline"] as const)
  test(`a maximum-length ace ${kind} comment permits a small authored edit`, async () => {
    const authored = "x".repeat(60_000);
    const hosted = `${authored}\n\n<!-- ace-write:${"a".repeat(64)} -->`;
    const f = await commentEditor(hosted, kind);
    try {
      const field = await startEdit();
      expect(field.value).toBe(authored);
      fireEvent.change(field, { target: { value: authored.slice(0, -1) } });
      await userEvent.click(screen.getByRole("button", { name: "Update comment" }));
      await waitFor(() => expect(f.sent).toHaveLength(1));
      expect(f.sent).toEqual([
        {
          kind: "comment.edit",
          source: kind,
          commentId: 7,
          body: authored.slice(0, -1),
          expectedBody: hosted,
        },
      ]);
    } finally {
      await f.close();
    }
  });

async function chooseDelete() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Actions for reviewer's comment" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
}

test("deleting the viewer's comment asks first and sends nothing when cancelled", async () => {
  const f = await commentEditor("Remove me");
  try {
    await chooseDelete();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(f.sent).toEqual([]);
    await chooseDelete();
    await userEvent.click(await screen.findByRole("button", { name: "Delete comment" }));
    await waitFor(() =>
      expect(f.sent).toEqual([
        { kind: "comment.delete", source: "issue", commentId: 7, expectedBody: "Remove me" },
      ]),
    );
  } finally {
    await f.close();
  }
});

test("someone else's comment offers no Edit or Delete", async () => {
  const f = await reviewHarness({
    detail: reviewDetail(),
    state: reviewState({ viewer: "someone-else" }),
    ui: row("Not yours"),
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for reviewer's comment" }),
    );
    await screen.findByRole("menuitem", { name: "Copy link" });
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  } finally {
    await f.close();
  }
});
