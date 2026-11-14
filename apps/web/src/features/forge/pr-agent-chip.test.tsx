import { ClientProvider } from "@ace/client-react";
import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { useLinkedTasks } from "./pr-agent-chip.tsx";

const linked = ThreadId.parse("thread-linked");
const other = ThreadId.parse("thread-other");

function Linked() {
  const { cards } = useLinkedTasks({
    relatedThreads: [{ id: linked, title: "Linked", archived: false }],
  });
  return <output aria-label="linked">{cards.map((card) => card.status.tone).join(",")}</output>;
}

test("a step in a thread the PR doesn't link re-renders none of its task marks", async () => {
  const made = harness();
  createIdleTask(made.daemon, {
    id: linked,
    title: "Linked",
    workspaceId: "ws",
    provider: "codex",
  });
  createIdleTask(made.daemon, { id: other, title: "Other", workspaceId: "ws", provider: "codex" });
  await made.client.start();
  let commits = 0;
  render(
    <ClientProvider client={made.client}>
      <Profiler id="linked" onRender={() => void commits++}>
        <Linked />
      </Profiler>
    </ClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("linked").textContent).toBe("done"));
  const before = commits;

  await act(async () => made.daemon.apply(other, [facts.turn("root")]));
  await act(async () =>
    made.daemon.apply(other, [facts.message("root", "reply", "assistant", "Reading")]),
  );
  expect(commits).toBe(before);

  await act(async () => made.daemon.apply(linked, [facts.turn("root")]));
  await waitFor(() => expect(screen.getByLabelText("linked").textContent).not.toBe("done"));
  expect(commits).toBeGreaterThan(before);
});
