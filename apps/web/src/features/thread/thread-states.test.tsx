import { ClientError } from "@ace/client";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { threadLoadFailure } from "./thread-load-error.tsx";

test("a thread the daemon doesn't have says so in words and offers the way back", async () => {
  await harness().open("/t/thread-that-was-deleted");
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByRole("heading", { name: "This thread doesn't exist" })).toBeTruthy();
  expect(alert.textContent).toContain("It may have been deleted or belong to another machine.");
  // Nothing went wrong with the connection, so nothing is said about agents still working.
  expect(alert.textContent).not.toContain("keep working");
  expect(within(alert).getByRole("link", { name: "Back to Home" })).toBeTruthy();

  expect(alert.textContent).not.toContain("not_found");
  expect(screen.queryByText("Loading thread…")).toBeNull();
});

test("only a lost or slow connection says the agents keep working", () => {
  expect(threadLoadFailure(new ClientError("timeout")).description).toBe(
    "ace took too long to answer. Try again in a moment. The agents keep working.",
  );
  const refused = threadLoadFailure(new ClientError("daemon", "forbidden"));
  expect(refused).toMatchObject({
    title: "This thread couldn't be loaded",
    description: "This device isn't allowed to read this.",
    code: "forbidden",
  });
});

test("a denied deleted-thread URL explains that the thread is missing", async () => {
  const app = harness();
  app.daemon.refuseRequests("read_denied", "subscribe");
  await app.open("/t/deleted-thread");
  expect(await screen.findByRole("heading", { name: "This thread doesn't exist" })).toBeTruthy();
  expect(screen.queryByText("Something went wrong")).toBeNull();
});
