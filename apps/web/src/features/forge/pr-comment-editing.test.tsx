import { expect, test } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import {
  ClientMessage,
  DeviceId,
  ForgeComment,
  ForgePrDetail,
  ServerMessage,
  WorkspaceId,
  type ForgeReviewAction,
} from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { PrReviewWorkspace } from "./pr-review-context.tsx";
import { PrOwnComment } from "./pr-review-forms.tsx";
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const headSha = "a".repeat(40);
const detail = ForgePrDetail.parse({
  status: {
    ref: { repository, number: 42 },
    title: "Review",
    url: "https://github.com/acme/api/pull/42",
    headSha,
    state: "open",
    mergeability: "unknown",
    ci: "none",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
  },
  body: "Description",
  author: "author",
  headBranch: "feature",
  baseBranch: "main",
  baseSha: "b".repeat(40),
  headRepository: repository,
  labels: [],
  reviewers: [],
  reviewDecision: null,
  commits: 1,
  changedFiles: 1,
  relatedThreads: [],
  relatedThreadsTruncated: false,
});
async function commentEditor(body: string, source: "issue" | "inline" = "issue") {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId: WorkspaceId.parse("api"), repository, number: 42 },
    {
      resource: "prReviewState",
      value: {
        viewer: "reviewer",
        headSha,
        drafts: [],
        viewed: null,
        canReview: true,
        canComment: true,
        resolvableThreads: [],
        operations: [],
      },
    },
  );
  const sent: ForgeReviewAction[] = [];
  let refusal: string | undefined;
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("review-device"),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    id: () => `comment-${++ids}`,
    random: () => 0.5,
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    transport: () => {
      const transport = fakeTransport(daemon);
      return {
        ...transport,
        send(text) {
          const message = ClientMessage.parse(JSON.parse(text));
          if (message.type === "command" && message.command.payload.type === "forge.hosted.review")
            sent.push(message.command.payload.action);
          transport.send(text);
        },
        open(events) {
          transport.open({
            ...events,
            message(text) {
              const message = ServerMessage.parse(JSON.parse(text));
              if (
                message.type === "commandResult" &&
                message.error === "unsupported_by_fake_daemon"
              )
                events.message(
                  JSON.stringify(
                    refusal
                      ? { ...message, error: refusal }
                      : { type: "commandResult", commandId: message.commandId, ok: true },
                  ),
                );
              else events.message(text);
            },
          });
        },
      };
    },
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (text: string) => (
    <ClientProvider client={client}>
      <QueryClientProvider client={query}>
        <PrReviewWorkspace workspaceId="api" detail={detail} onRefresh={() => {}}>
          <PrOwnComment
            key={7}
            comment={ForgeComment.parse({
              kind: source,
              id: 7,
              author: "reviewer",
              body: text,
              file: null,
              line: null,
              updatedAt: "2026-10-10",
              replyTo: null,
            })}
          />
        </PrReviewWorkspace>
      </QueryClientProvider>
    </ClientProvider>
  );
  await client.start();
  const view = render(ui(body));
  await screen.findByRole("button", { name: "Edit comment" });
  return {
    sent,
    refresh(text: string) {
      view.rerender(ui(text));
    },
    refuse(code: string) {
      refusal = code;
    },
    async close() {
      view.unmount();
      query.clear();
      await client.close();
    },
  };
}

test("beginning an edit after refresh takes the current text and guard together", async () => {
  const f = await commentEditor("Original A");
  try {
    f.refresh("External B");
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit GitHub comment" }).value,
    ).toBe("External B");
    await userEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await screen.findByText("Saved.");
    expect(f.sent).toEqual([
      {
        kind: "comment.edit",
        source: "issue",
        commentId: 7,
        body: "External B",
        expectedBody: "External B",
      },
    ]);
  } finally {
    await f.close();
  }
});

test("a refresh during an edit retains its original guard and reports conflict without losing the draft", async () => {
  const f = await commentEditor("Original A");
  try {
    // The first refresh precedes Edit; this is the version the person begins editing.
    f.refresh("External B");
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit GitHub comment" });
    await userEvent.type(field, " edited locally");
    // Another device writes again during the edit, and refresh must not advance its guard.
    f.refresh("External C");
    f.refuse("forge_conflict");
    await userEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await screen.findByText("The GitHub resource changed while reading. Refresh before continuing.");
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
    expect(screen.getByRole("button", { name: "Save comment" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit GitHub comment" }).value,
    ).toBe("External C");
  } finally {
    await f.close();
  }
});

for (const source of ["issue", "inline"] as const)
  test(`a maximum-length ace ${source} comment permits a small authored edit`, async () => {
    const authored = "x".repeat(60_000);
    const hosted = `${authored}\n\n<!-- ace-write:${"a".repeat(64)} -->`;
    const f = await commentEditor(hosted, source);
    try {
      await userEvent.click(screen.getByRole("button", { name: "Edit comment" }));
      const field = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit GitHub comment",
      });
      expect(field.value).toBe(authored);
      fireEvent.change(field, { target: { value: authored.slice(0, -1) } });
      await userEvent.click(screen.getByRole("button", { name: "Save comment" }));
      await screen.findByText("Saved.");
      expect(f.sent).toEqual([
        {
          kind: "comment.edit",
          source,
          commentId: 7,
          body: authored.slice(0, -1),
          expectedBody: hosted,
        },
      ]);
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Edit GitHub comment" })).toBeNull(),
      );
    } finally {
      await f.close();
    }
  });
