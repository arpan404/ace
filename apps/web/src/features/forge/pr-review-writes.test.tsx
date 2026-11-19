import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FakeDaemon } from "@ace/fake-daemon";
import { CommandId, type ForgePrRef } from "@ace/protocol";
import { fakeClient } from "@/test/fake-client.ts";
import { useReviewWrites } from "./pr-review-writes.ts";

const pr: ForgePrRef = {
  repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
  number: 7,
};

function writes(answer: { ok: boolean; error?: string }, reread: () => Promise<unknown>) {
  const client = fakeClient(new FakeDaemon({ clock: () => 1_000 }));
  // GitHub's answer to the write, at the daemon boundary.
  vi.spyOn(client, "command").mockResolvedValue({
    commandId: CommandId.parse("command-1"),
    ...answer,
  });
  const settled: boolean[] = [];
  const view = renderHook(() =>
    useReviewWrites({
      client,
      workspaceId: "project",
      pr,
      ready: true,
      disabled: false,
      commentsLocked: false,
      onSettled: (_kind, ok) => {
        settled.push(ok);
        return reread();
      },
    }),
  );
  return { view, settled };
}

const reply = { kind: "reply", commentId: 11, body: "Fixed." } as const;

test("a reply GitHub took stays sent when reading the pull request again fails", async () => {
  const { view, settled } = writes({ ok: true }, () => Promise.reject(new Error("offline")));
  await expect(view.result.current.write(reply)).resolves.toEqual({ ok: true });
  expect(settled).toEqual([true]);
});

test("a reply GitHub refused is reported with its reason, and the review is read again", async () => {
  const { view, settled } = writes({ ok: false, error: "forge_forbidden" }, () =>
    Promise.reject(new Error("offline")),
  );
  const result = await view.result.current.write(reply);
  expect(result.ok).toBe(false);
  await waitFor(() => expect(settled).toEqual([false]));
});
