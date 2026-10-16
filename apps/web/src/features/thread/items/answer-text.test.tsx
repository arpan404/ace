import { Profiler } from "react";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, facts } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { AssistantMessage } from "./messages.tsx";

/** A paged UTF-16 stream at the daemon's output boundary, served over the real client protocol. */
class AnswerDaemon extends FakeDaemon {
  answer = Buffer.from(
    "Intro\n\n" + "word ".repeat(32_000) + "😀 Ending beyond the preview",
    "utf16le",
  );
  unavailable = false;
  override output(streamId: string, offset: number, limit: number) {
    if (streamId !== "answer") return super.output(streamId, offset, limit);
    if (this.unavailable) return undefined;
    const bytes = this.answer.subarray(offset, offset + limit);
    return {
      bytes,
      nextOffset: offset + bytes.length,
      eof: offset + bytes.length >= this.answer.length,
    };
  }
}

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

test("a failed automatic answer read keeps the preview and retries the complete paged answer", async () => {
  const daemon = new AnswerDaemon({ clock: () => 1000 });
  const full = daemon.answer.toString("utf16le");
  new ScenarioPlayer(daemon, {
    thread: {
      id: "answer-preview",
      workspaceId: "project",
      provider: "codex",
      title: "Long answer",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "answer",
            draft: {
              type: "message",
              role: "assistant",
              complete: true,
              parts: [
                {
                  type: "text",
                  text: full.slice(0, 4096),
                  source: { streamId: "answer", bytes: daemon.answer.length, encoding: "utf-16le" },
                },
              ],
            },
          },
          facts.endTurn("root"),
        ],
      },
    ],
  }).runUntilBlocked();
  daemon.unavailable = true;
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread("answer-preview");
  await waitFor(() => expect(lease.store.order.length).toBe(1));
  const itemId = lease.store.order[0];
  if (!itemId) throw new Error("Missing answer");
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  render(
    <ClientProvider client={client}>
      <TooltipProvider>
        <AssistantMessage threadId="answer-preview" itemId={itemId} />
      </TooltipProvider>
    </ClientProvider>,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Copy preview" }));
  await waitFor(() => expect(copied).toBe(full.slice(0, 4096)));
  expect(screen.queryByRole("button", { name: "Copy answer" })).toBeNull();

  daemon.unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(await screen.findByText(/Ending beyond the preview/, {}, { timeout: 5000 })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Copy answer" }));
  await waitFor(() => expect(copied).toBe(full));
  lease.release();
});

test.each(["interrupted", "failed"] as const)(
  "an incomplete source-backed answer loads automatically and remains copyable after its run is %s",
  async (outcome) => {
    const daemon = new AnswerDaemon({ clock: () => 1000 });
    const full = daemon.answer.toString("utf16le");
    new ScenarioPlayer(daemon, {
      thread: {
        id: "answer-preview",
        workspaceId: "project",
        provider: "codex",
        title: "Stopped answer",
      },
      steps: [
        {
          kind: "facts",
          facts: [
            facts.rootAgent("codex"),
            facts.turn("root"),
            {
              type: "item.upsert",
              agent: "root",
              item: "answer",
              draft: {
                type: "message",
                role: "assistant",
                complete: false,
                parts: [
                  {
                    type: "text",
                    text: full.slice(0, 4096),
                    source: {
                      streamId: "answer",
                      bytes: daemon.answer.length,
                      encoding: "utf-16le",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    }).runUntilBlocked();
    const client = fakeClient(daemon);
    await client.start();
    const lease = client.thread("answer-preview");
    await waitFor(() => expect(lease.store.order.length).toBe(1));
    const itemId = lease.store.order[0];
    if (!itemId) throw new Error("Missing answer");
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });
    const view = render(
      <ClientProvider client={client}>
        <TooltipProvider>
          <AssistantMessage threadId="answer-preview" itemId={itemId} />
        </TooltipProvider>
      </ClientProvider>,
    );
    await screen.findByRole("status", { name: "Streaming" });
    expect(
      await screen.findByText(/Ending beyond the preview/, {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show full answer" })).toBeNull();
    act(() => daemon.apply("answer-preview", [facts.endTurn("root", outcome)]));

    expect(
      await screen.findByText(/Ending beyond the preview/, {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Streaming" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(copied).toBe(full));
    view.unmount();
    lease.release();
  },
);

test("appending an answer delta does not render a settled answer again", async () => {
  const daemon = new AnswerDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, {
    thread: {
      id: "localized-delta",
      workspaceId: "project",
      provider: "codex",
      title: "Localized rendering",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          facts.message("root", "settled", "assistant", "Settled answer stays still."),
          facts.message("root", "writing", "assistant", "Still writing", false),
        ],
      },
    ],
  }).runUntilBlocked();
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread("localized-delta");
  await waitFor(() => expect(lease.store.order.length).toBe(2));
  const [settled, writing] = lease.store.order;
  if (!settled || !writing) throw new Error("Missing messages");
  let settledCommits = 0;
  const view = render(
    <ClientProvider client={client}>
      <TooltipProvider>
        <Profiler id="settled-answer" onRender={() => settledCommits++}>
          <AssistantMessage threadId="localized-delta" itemId={settled} />
        </Profiler>
        <AssistantMessage threadId="localized-delta" itemId={writing} />
      </TooltipProvider>
    </ClientProvider>,
  );
  await screen.findByText("Settled answer stays still.");
  await screen.findByText("Still writing");
  const before = settledCommits;
  act(() => daemon.apply("localized-delta", [facts.stream("root", "writing", " the next chunk.")]));
  expect(await screen.findByText("Still writing the next chunk.")).toBeTruthy();
  expect(settledCommits).toBe(before);
  view.unmount();
  lease.release();
});
