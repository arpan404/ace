import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import {
  ClientMessage,
  DeviceId,
  ForgePrDetail,
  ForgeReviewState,
  ServerMessage,
  WorkspaceId,
  type ForgeReviewAction,
} from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { LayoutProvider } from "@/lib/layout.tsx";
import { memoryKeyValue } from "@/test/harness.tsx";
import { PrQuoteProvider } from "./pr-quote.tsx";
import { PrUiProvider } from "./pr-ui-store.tsx";
import { PrReviewWorkspace } from "./pr-review-context.tsx";

/* Test support: a pull request's review workspace on a real client and fake daemon. */

export const repository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "api",
} as const;
export const headSha = "a".repeat(40);

export function reviewDetail(status: Partial<ForgePrDetail["status"]> = {}, author = "author") {
  return ForgePrDetail.parse({
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
      ...status,
    },
    body: "Description",
    author,
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
}

export function reviewState(state: Partial<ForgeReviewState> = {}) {
  return ForgeReviewState.parse({
    viewer: "reviewer",
    headSha,
    drafts: [],
    viewed: null,
    canReview: true,
    canComment: true,
    resolvableThreads: [],
    operations: [],
    // GitHub reported which comments are hidden: none.
    hidden: [],
    hideable: [],
    ...state,
  });
}

export const inlineComment = (id: number, body: string, author = "reviewer", line = 7) => ({
  kind: "inline" as const,
  id,
  author,
  body,
  file: "src/main.ts",
  line,
  updatedAt: "2026-10-10T10:00:00Z",
  replyTo: null,
});

/**
 * Renders `ui` inside the review workspace for `detail`, with the review state given. Every
 * hosted review command is recorded in `sent` and answered ok, or with the code set by `refuse`,
 * or held until `release` when `hold` is on; `uncertain` makes the daemon lose track of it.
 */
export async function reviewHarness(options: {
  detail: ForgePrDetail;
  state: ForgeReviewState;
  ui: ReactNode;
  onConversation?: () => void;
  /** The conversation is locked to this account. */
  commentsLocked?: boolean;
}) {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  const read = {
    op: "forge.pr.review-state",
    workspaceId: WorkspaceId.parse("api"),
    repository,
    number: 42,
  } as const;
  daemon.workspace.setForgeRead(read, { resource: "prReviewState", value: options.state });
  const sent: ForgeReviewAction[] = [];
  let refusal: string | undefined;
  let uncertain = false;
  let held: (() => void)[] | undefined;
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
                message.type !== "commandResult" ||
                message.error !== "unsupported_by_fake_daemon"
              )
                return events.message(text);
              // Script the daemon's answer at the wire, leaving the real client intact.
              if (uncertain)
                daemon.workspace.setForgeRead(read, {
                  resource: "prReviewState",
                  value: {
                    ...options.state,
                    operations: [{ id: message.commandId, state: "uncertain" }],
                  },
                });
              const answer = JSON.stringify(
                uncertain
                  ? { ...message, error: "action_outcome_uncertain" }
                  : refusal
                    ? { ...message, error: refusal }
                    : { type: "commandResult", commandId: message.commandId, ok: true },
              );
              if (held) held.push(() => events.message(answer));
              else events.message(answer);
            },
          });
        },
      };
    },
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const storage = memoryKeyValue();
  const tree = (ui: ReactNode, detail = options.detail) => (
    <ClientProvider client={client}>
      <QueryClientProvider client={query}>
        <LayoutProvider storage={storage}>
          <TooltipProvider delay={0}>
            <ToastProvider>
              <PrUiProvider>
                <PrQuoteProvider onConversation={options.onConversation ?? (() => {})}>
                  <PrReviewWorkspace
                    workspaceId="api"
                    detail={detail}
                    commentsLocked={options.commentsLocked}
                    onRefresh={() => {}}
                  >
                    {ui}
                  </PrReviewWorkspace>
                </PrQuoteProvider>
              </PrUiProvider>
            </ToastProvider>
          </TooltipProvider>
        </LayoutProvider>
      </QueryClientProvider>
    </ClientProvider>
  );
  await client.start();
  const view = render(tree(options.ui));
  return {
    sent,
    rerender(ui: ReactNode, detail?: ForgePrDetail) {
      view.rerender(tree(ui, detail));
    },
    refuse(code: string | undefined) {
      refusal = code;
    },
    loseTrack() {
      uncertain = true;
    },
    hold() {
      held = [];
    },
    release() {
      const answers = held ?? [];
      held = undefined;
      for (const answer of answers) answer();
    },
    async close() {
      view.unmount();
      query.clear();
      await client.close();
    },
  };
}
