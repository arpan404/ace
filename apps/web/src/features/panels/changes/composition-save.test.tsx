import { FakeDaemon } from "@ace/fake-daemon";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { PanelServicesContext, panelServices } from "../services.ts";
import { CompositionEditor } from "./composition-editor.tsx";
import { beginComposition, type ReviewComposition } from "./compositions.ts";
import { persistReview } from "./review-store.ts";

test("saving an editor whose saved target is missing refuses to create a replacement comment", async () => {
  const services = await panelServices(fakeClient(new FakeDaemon({ clock: () => 1000 })));
  const storage = memoryKeyValue();
  persistReview(services, storage, () => {});
  const entry: ReviewComposition = {
    id: "stale-editor",
    key: "discarded-target",
    threadId: "thread",
    file: "file.ts",
    range: { side: "new", start: 1, end: 1 },
    version: "original",
    needsReselection: false,
    text: "Do not revive this finding",
    suggestion: "replacement",
    fingerprint: { before: [], lines: ["original"], after: [] },
    source: undefined,
  };
  // The stale edit callback can arrive after deletion, before its old annotation unmounts.
  beginComposition(services.compositions, entry);
  render(
    <PanelServicesContext.Provider value={services}>
      <CompositionEditor composition={entry} onReselect={() => {}} />
    </PanelServicesContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  const reloaded = await panelServices(fakeClient(new FakeDaemon({ clock: () => 1000 })));
  persistReview(reloaded, storage, () => {});
  expect(reloaded.drafts.get()).toEqual([]);
  // A second stale callback must not create an orphan after the first editor was removed.
  await userEvent.click(screen.getByRole("textbox", { name: "Comment on line 1" }));
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  expect(services.drafts.get()).toEqual([]);
});
