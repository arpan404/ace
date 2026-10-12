import { Client } from "@ace/client";
import type { KeyValueStorage } from "@ace/ui-core";
import { fakeTransport, workbench, type FakeDaemon } from "@ace/fake-daemon";
import {
  DeviceId,
  ForgeIssueDetail,
  ForgePrDetail,
  ServerMessage,
  WorkspaceId,
} from "@ace/protocol";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const ref = { repository, number: 42 };
const issue = ForgeIssueDetail.parse({
  ref,
  title: "Investigate issue context",
  url: "https://github.com/acme/api/issues/42",
  author: "author",
  state: "open",
  labels: [],
  assignees: [],
  milestone: null,
  createdAt: "2026-10-10",
  updatedAt: "2026-10-10",
  body: "Original issue description",
  permissions: { edit: true, close: true, reopen: false, comment: true, reason: "" },
  relatedThreads: [],
  relatedThreadsTruncated: false,
});
const pr = ForgePrDetail.parse({
  status: {
    ref,
    title: "Investigate PR context",
    url: "https://github.com/acme/api/pull/42",
    headSha: "a".repeat(40),
    state: "open",
    mergeability: "unknown",
    ci: "none",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
  },
  body: "Original PR description",
  author: "author",
  headBranch: "fix/context",
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

beforeEach(() => localStorage.clear());

/** Delay only source metadata at the transport boundary; the real composer and SDK still run. */
function app(
  source: "issue" | "pr",
  storage: KeyValueStorage = memoryKeyValue(),
  daemon?: FakeDaemon,
) {
  const arrived = Promise.withResolvers<() => void>();
  const made = harness({
    storage,
    ...(daemon ? { daemon } : {}),
    client(target) {
      let ids = 0;
      let holding = true;
      return new Client({
        deviceId: DeviceId.parse("test-device"),
        credential: async () => target.token,
        storage: memoryStorage(),
        random: () => 0.5,
        id: () => `prefill-${++ids}`,
        scheduler: {
          set(ms, run) {
            const timer = setTimeout(run, ms);
            return () => clearTimeout(timer);
          },
        },
        transport() {
          const inner = fakeTransport(target);
          return {
            ...inner,
            open(events) {
              inner.open({
                ...events,
                message(text) {
                  const message = ServerMessage.parse(JSON.parse(text));
                  if (
                    holding &&
                    message.type === "workspace.result" &&
                    message.result.kind === "forge" &&
                    message.result.data.resource ===
                      (source === "issue" ? "issueDetail" : "prDetail")
                  ) {
                    arrived.resolve(() => {
                      holding = false;
                      events.message(text);
                    });
                  } else events.message(text);
                },
              });
            },
          };
        },
      });
    },
  });
  if (!daemon) for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  if (source === "issue")
    made.daemon.workspace.setForgeRead(
      { op: "forge.issue.detail", workspaceId, repository, number: 42 },
      { resource: "issueDetail", value: issue },
    );
  else
    made.daemon.workspace.setForgeRead(
      { op: "forge.pr.detail", workspaceId, repository, number: 42 },
      { resource: "prDetail", value: pr },
    );
  const url = source === "issue" ? issue.url : pr.status.url;
  const route = `/new?project=api&${source === "issue" ? "issue" : "pullRequest"}=${encodeURIComponent(url)}`;
  return { ...made, route, arrived: arrived.promise };
}

async function sourceLoaded() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBeNull(),
  );
}

for (const source of ["issue", "pr"] as const) {
  test(`uncached ${source} metadata prefills a fresh preparation and a later reopen keeps the edited draft`, async () => {
    const first = app(source);
    await first.open(first.route);
    const deliver = await first.arrived;
    expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe("");
    await act(async () => deliver());
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" }).textContent).toContain(
        source === "issue" ? issue.body : pr.body,
      ),
    );
    const message = screen.getByRole("combobox", { name: "Message" });
    await userEvent.clear(message);
    await userEvent.type(message, "My edited source task");
    await screen.findByRole("link", { name: /^My edited source task\. Draft/ });
    cleanup();
    await first.client.close();
    const reopened = app(source, first.storage, first.daemon);
    await reopened.open(reopened.route);
    const refresh = await reopened.arrived;
    expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
      "My edited source task",
    );
    await act(async () => refresh());
    await sourceLoaded();
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "My edited source task",
    );
  });

  for (const writes of ["saved", "refused"] as const) {
    test(`edits before ${source} metadata arrives survive even when draft writes are ${writes}`, async () => {
      const storage = memoryKeyValue();
      const save = storage.setItem;
      let refuse = false;
      storage.setItem = (key, value) => {
        if (refuse && key === "ace.composer.drafts") throw new Error("Storage full");
        save(key, value);
      };
      const made = app(source, storage);
      await made.open(made.route);
      const deliver = await made.arrived;
      const message = await screen.findByRole("combobox", { name: "Message" });
      refuse = writes === "refused";
      await userEvent.type(message, "Keep my text while metadata loads");
      if (refuse) await screen.findByText(/Couldn't save this preparation on this device/);
      await act(async () => deliver());
      await sourceLoaded();
      expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
        "Keep my text while metadata loads",
      );
      // Clearing remains an edit; loaded metadata must not recreate the source description.
      await userEvent.clear(screen.getByRole("combobox", { name: "Message" }));
      expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("");
    });
  }
}
