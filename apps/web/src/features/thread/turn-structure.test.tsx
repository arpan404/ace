import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function scenario(id: string) {
  const found = workbench().find((candidate) => candidate.thread.id === id);
  if (!found) throw new Error(`workbench lost ${id}`);
  return found;
}

test("a question sits in the transcript where the agent asked it", async () => {
  const app = harness();
  app.play(scenario("thread-sheet-rotate")).runUntilBlocked();
  await app.open("/t/thread-sheet-rotate");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("article", {
    name: "How should the sheet recover after rotate?",
  });
  const finding = within(feed).getByText(/three ways to fix it/);
  expect(finding.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Once, in place: not again under the transcript.
  expect(
    screen.getAllByRole("article", { name: "How should the sheet recover after rotate?" }),
  ).toHaveLength(1);
});
