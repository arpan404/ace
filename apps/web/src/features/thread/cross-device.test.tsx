import { crossDevice } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

test("a child delegated to another machine names that machine on its row and stays out of local navigation", async () => {
  const app = harness();
  app.play(crossDevice()).runUntilBlocked();
  await app.open("/t/thread-cross-device");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const row = await within(feed).findByRole("button", { name: /^GPU build review on Studio/ });
  expect(row.textContent).toContain("on Studio");
  // Its thread lives on the Studio, so the row is not a link into a thread here.
  expect(within(feed).queryByRole("link", { name: /GPU build review/ })).toBeNull();
  await waitFor(() => expect(feed.textContent).toContain("staging.relay.dev"));
  expect(feed.textContent).toContain("On studio, ");
});
