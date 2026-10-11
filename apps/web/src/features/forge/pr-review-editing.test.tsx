import { useState } from "react";
import { expect, test } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import {
  ClientMessage,
  DeviceId,
  ForgePrDetail,
  ServerMessage,
  WorkspaceId,
  type ForgeReviewAction,
} from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { PrReviewWorkspace } from "./pr-review-context.tsx";
import { PrReviewSubmission, PrInlineDraft, PrConversationComposer } from "./pr-review-forms.tsx";

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
const anchor = { commit: headSha, path: "src/main.ts", line: 1, side: "RIGHT" } as const;
const prKey = JSON.stringify(detail.status.ref);
function InlineEditor() {
  const [open, setOpen] = useState(true);
  return open ? (
    <PrInlineDraft prKey={prKey} anchor={anchor} onClose={() => setOpen(false)} />
  ) : (
    <p>Inline editor closed</p>
  );
}
const forms = [
  {
    kind: "submit",
    label: "Review summary",
    button: "Submit comment review",
    node: <PrReviewSubmission detail={detail} />,
    key: `ace:hosted-review:${prKey}:${headSha}`,
  },
  {
    kind: "draft.save",
    label: "Inline comment draft",
    button: "Save review draft",
    node: <InlineEditor />,
    key: `ace:inline:${prKey}:${JSON.stringify(anchor)}`,
  },
  {
    kind: "conversation",
    label: "PR conversation comment",
    button: "Post conversation comment",
    node: <PrConversationComposer prKey={prKey} />,
    key: `ace:conversation:${prKey}:new`,
  },
  {
    kind: "reply",
    label: "Reply to review thread",
    button: "Post reply",
    node: <PrConversationComposer prKey={prKey} replyTo={5} />,
    key: `ace:conversation:${prKey}:5`,
  },
] as const;

for (const form of forms)
  test.each(["edited", "unchanged"] as const)(
    `${form.kind} acceptance preserves later text and clears unchanged text: %s`,
    async (change) => {
      localStorage.clear();
      const daemon = new FakeDaemon({ clock: () => 1_000 });
      daemon.workspace.setForgeRead(
        {
          op: "forge.pr.review-state",
          workspaceId: WorkspaceId.parse("api"),
          repository,
          number: 42,
        },
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
      const dispatched = Promise.withResolvers<void>();
      let accept: (() => void) | undefined;
      const submitted: ForgeReviewAction[] = [];
      let ids = 0;
      const client = new Client({
        deviceId: DeviceId.parse("review-device"),
        credential: async () => daemon.token,
        storage: memoryStorage(),
        id: () => `review-${++ids}`,
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
              if (
                message.type === "command" &&
                message.command.payload.type === "forge.hosted.review"
              )
                submitted.push(message.command.payload.action);
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
                  ) {
                    // Hold the daemon acknowledgement at the wire boundary.
                    accept = () =>
                      events.message(
                        JSON.stringify({
                          type: "commandResult",
                          commandId: message.commandId,
                          ok: true,
                        }),
                      );
                    dispatched.resolve();
                  } else events.message(text);
                },
              });
            },
          };
        },
      });
      const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      try {
        await client.start();
        const view = render(
          <ClientProvider client={client}>
            <QueryClientProvider client={query}>
              <PrReviewWorkspace workspaceId="api" detail={detail} onRefresh={() => {}}>
                {form.node}
              </PrReviewWorkspace>
            </QueryClientProvider>
          </ClientProvider>,
        );
        const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: form.label });
        await userEvent.type(field, "Submitted A");
        const button = screen.getByRole<HTMLButtonElement>("button", { name: form.button });
        await waitFor(() => expect(button.disabled).toBe(false));
        await userEvent.click(button);
        await dispatched.promise;
        if (change === "edited") {
          await userEvent.clear(field);
          await userEvent.type(field, "Unpublished B");
        }
        await act(async () => {
          if (!accept) throw new Error("No pending acknowledgement");
          accept();
        });
        await screen.findByText("Saved.");
        expect(submitted[0]).toMatchObject(
          form.kind === "draft.save"
            ? { kind: "draft.save", draft: { body: "Submitted A" } }
            : { kind: form.kind, body: "Submitted A" },
        );
        await waitFor(() => {
          expect(localStorage.getItem(form.key)).toBe(
            JSON.stringify(change === "edited" ? "Unpublished B" : ""),
          );
          if (form.kind === "draft.save" && change === "unchanged")
            expect(screen.queryByRole("textbox", { name: form.label })).toBeNull();
          else
            expect(
              screen.getByRole<HTMLTextAreaElement>("textbox", { name: form.label }).value,
            ).toBe(change === "edited" ? "Unpublished B" : "");
        });
        view.unmount();
      } finally {
        query.clear();
        await client.close();
      }
    },
  );
