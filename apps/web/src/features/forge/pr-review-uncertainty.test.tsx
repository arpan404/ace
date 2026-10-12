import { expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, ForgePrDetail, ServerMessage, WorkspaceId } from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { PrReviewWorkspace } from "./pr-review-context.tsx";
import { PrReviewSubmission } from "./pr-review-forms.tsx";
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

test("an uncertain review receipt retains the summary and refreshes its reconciliation control", async () => {
  localStorage.clear();
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  const operation = {
    op: "forge.pr.review-state",
    workspaceId: WorkspaceId.parse("api"),
    repository,
    number: 42,
  } as const;
  const state = {
    viewer: "reviewer",
    headSha,
    drafts: [],
    viewed: null,
    canReview: true,
    canComment: true,
    resolvableThreads: [],
    operations: [],
  };
  daemon.workspace.setForgeRead(operation, { resource: "prReviewState", value: state });
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
        open(events) {
          transport.open({
            ...events,
            message(text) {
              const message = ServerMessage.parse(JSON.parse(text));
              // Script the daemon's reply at the wire boundary, leaving the real client/outbox intact.
              if (
                message.type === "commandResult" &&
                message.error === "unsupported_by_fake_daemon"
              ) {
                daemon.workspace.setForgeRead(operation, {
                  resource: "prReviewState",
                  value: { ...state, operations: [{ id: message.commandId, state: "uncertain" }] },
                });
                events.message(JSON.stringify({ ...message, error: "action_outcome_uncertain" }));
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
            <PrReviewSubmission detail={detail} />
          </PrReviewWorkspace>
        </QueryClientProvider>
      </ClientProvider>,
    );
    const summary = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Review summary" });
    await userEvent.type(summary, "Keep my review");
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Submit comment review" });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await userEvent.click(submit);
    expect(
      await screen.findByText(
        /GitHub may have accepted this action. Reconcile the write before retrying/,
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Reconcile write" })).toBeTruthy();
    expect(summary.value).toBe("Keep my review");
    view.unmount();
  } finally {
    query.clear();
    await client.close();
  }
});
