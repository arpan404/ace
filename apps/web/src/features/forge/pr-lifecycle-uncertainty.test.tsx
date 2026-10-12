import { expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import {
  DeviceId,
  ForgePrDetail,
  ForgeLifecycleState,
  ServerMessage,
  WorkspaceId,
} from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { PrLifecycle } from "./pr-lifecycle.tsx";
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

test("an uncertain lifecycle receipt retains metadata text and refreshes its result-check control", async () => {
  localStorage.clear();
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  const operation = {
    op: "forge.pr.lifecycle",
    workspaceId: WorkspaceId.parse("api"),
    repository,
    number: 42,
  } as const;
  const state = ForgeLifecycleState.parse({
    snapshot: {
      pr: detail.status.ref,
      id: "PR_42",
      version: "a".repeat(64),
      headSha,
      baseSha: detail.baseSha,
      state: "open",
      metadata: {
        title: detail.status.title,
        body: detail.body,
        baseBranch: "main",
        labels: [],
        assignees: [],
      },
      editableFields: ["body"],
      actions: [],
      unsupported: [],
    },
    operations: [],
  });
  daemon.workspace.setForgeRead(operation, { resource: "prLifecycle", value: state });
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
                  resource: "prLifecycle",
                  value: {
                    ...state,
                    operations: [{ id: message.commandId, kind: "edit", state: "uncertain" }],
                  },
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
          <PrLifecycle workspaceId="api" detail={detail} onRefresh={() => {}} />
        </QueryClientProvider>
      </ClientProvider>,
    );
    await screen.findByText(/Current state: open/);
    await userEvent.click(screen.getByText("Edit PR metadata"));
    const description = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "PR description",
    });
    await userEvent.clear(description);
    await userEvent.type(description, "Keep my metadata edit");
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save PR metadata" });
    await waitFor(() => expect(save.disabled).toBe(false));
    await userEvent.click(save);
    expect(
      await screen.findByText(
        /GitHub may have accepted this action. Check its result before retrying/,
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Check action result" })).toBeTruthy();
    expect(description.value).toBe("Keep my metadata edit");
    view.unmount();
  } finally {
    query.clear();
    await client.close();
  }
});
