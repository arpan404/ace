import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { threadWorkspace } from "@/features/panels/index.ts";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

afterEach(() => vi.restoreAllMocks());

/** The thread's tool kinds stay on their way, as on a slow first visit, until the gate opens. */
function holdKinds() {
  let ready = false;
  const { promise: opened, resolve: open } = Promise.withResolvers<void>();
  const load = threadWorkspace.load.bind(threadWorkspace);
  vi.spyOn(threadWorkspace, "loaded").mockImplementation(() => ready);
  vi.spyOn(threadWorkspace, "load").mockImplementation(() =>
    opened.then(() => {
      ready = true;
      return load();
    }),
  );
  return open;
}

test("⌘P pressed before the thread's tools have loaded opens quick open once they do", async () => {
  const app = harness();
  folderFixture(app.client, "thread-cold-start");
  app.play(coldStartReplay()).runThrough("turn-2");
  const release = holdKinds();
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  // A fresh thread's focus sits in the composer.
  const composer = await screen.findByLabelText("Message");
  composer.focus();
  await userEvent.keyboard("{Control>}p{/Control}");
  expect(screen.queryByRole("combobox", { name: "Search files" })).toBeNull();
  release();
  const field = await screen.findByRole("combobox", { name: "Search files" });
  expect(document.activeElement).toBe(field);
});
