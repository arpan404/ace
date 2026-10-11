import { ClientProvider } from "@ace/client-react";
import { FakeDaemon } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { checkoutOf } from "@ace/ui-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import { PrFieldDialog } from "./pr-field-dialog.tsx";

test("the link field submits a configured Enterprise URL to its connected daemon", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const threadId = ThreadId.parse("enterprise-field");
  daemon.createThread({
    id: threadId,
    workspaceId: "project",
    provider: "codex",
    title: "Enterprise",
  });
  const client = fakeClient(daemon);
  await client.start();
  await client.request({
    type: "settings.set",
    key: "sourceControl.preferences",
    layer: { kind: "global" },
    value: {
      hosts: [{ host: "git.example.com" }],
      host: "git.example.com",
      remote: "upstream",
    },
  });
  const checkout = checkoutOf({
    branch: "topic",
    worktree: "/project",
    repository: {
      forge: "github",
      host: "git.example.com",
      owner: "octo",
      name: "ace",
    },
  });
  if (!checkout) throw new Error("Missing checkout");
  render(
    <ClientProvider client={client}>
      <PrFieldDialog
        kind="link-pr"
        checkout={checkout}
        onClose={() => {}}
        onSubmit={async (change) => {
          if (change.kind !== "link-pr") throw new Error("Unexpected action");
          const repository = change.repository ?? checkout.repository;
          if (!repository) throw new Error("Missing repository");
          const result = await client.command({
            type: "forge.pr.link",
            link: { threadId, pr: { repository, number: change.number } },
          });
          if (!result.ok) throw new Error(result.error);
        }}
      />
    </ClientProvider>,
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Pull request" }),
    "https://git.example.com/octo/ace/pull/7",
  );
  await userEvent.click(screen.getByRole("button", { name: "Link" }));
  await waitFor(() => {
    const view = daemon.snapshot({ kind: "thread", threadId });
    expect(view && "thread" in view && view.thread.details?.linkedPrs?.[0]).toMatchObject({
      number: 7,
      repo: checkout.repository,
    });
  });
});
