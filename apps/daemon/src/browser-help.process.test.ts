import { afterEach, expect, it } from "vitest";
import { Help, answer, browsing, closeBrowsing, openRequest } from "./browser-help-test-support.ts";

afterEach(closeBrowsing);

it("a help request makes the thread need the person until they press Done, and the agent hears done", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  const call = agent.call("browser_request_help", {
    tabId,
    reason: "login",
    message: "Sign in with your work account",
  });
  const request = await openRequest(world, threadId);
  expect(request.request).toMatchObject({
    kind: "browser_help",
    tabId,
    reason: "login",
    url: "https://example.com/login",
  });
  expect(world.store.getThread(threadId)?.status.state).toBe("needs_you");

  // Agents can never answer it for the person.
  expect(
    answer(world, request.id, "ace-agent", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: false, error: "human_answer_required" });
  expect(
    answer(world, request.id, "person", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: true });
  const result = await call;
  expect(Help.parse(result.data)).toMatchObject({ status: "done", tabId });
  await world.endTurn(threadId);
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("a request for a tab the thread does not have is refused and nobody is asked", async () => {
  const { world, agent, threadId } = await browsing();
  const result = await agent.call("browser_request_help", {
    tabId: "no-such-tab",
    reason: "captcha",
    message: "Solve the check",
  });
  expect(result).toMatchObject({ failed: true, data: { code: "tab_not_found" } });
  await world.flush();
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("an unanswered request stays open after the turn ends, and the person's Done arrives as their next message", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  // A turn is running, so its end is a real one that closes what the turn left open.
  await world.startTurn(threadId);
  const result = await agent.call("browser_request_help", {
    tabId,
    reason: "two_factor",
    message: "Enter the code from your phone",
    timeoutSeconds: 5,
  });
  expect(Help.parse(result.data)).toMatchObject({ status: "pending", tabId });
  await world.endTurn(threadId);
  // Correctness first: the thread never reads as done while the person still has to act.
  expect(world.store.getThread(threadId)?.status.state).toBe("needs_you");

  const request = await openRequest(world, threadId);
  expect(
    answer(world, request.id, "person", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: true });
  await world.flush();
  const items = world.store.readItemPage(threadId, world.store.headSeq() + 1, 50).items;
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "user",
      parts: [
        expect.objectContaining({
          text: expect.stringContaining("I did what you asked in the browser: Enter the code"),
        }),
      ],
    }),
  );
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("an agent that carries on in a new turn withdraws the request nobody answered", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  const result = await agent.call("browser_request_help", {
    tabId,
    reason: "dialog",
    message: "Choose whether to leave the page",
    timeoutSeconds: 5,
  });
  expect(Help.parse(result.data).status).toBe("pending");
  await world.endTurn(threadId);
  expect(world.store.getThread(threadId)?.status.state).toBe("needs_you");

  await world.startTurn(threadId);
  const state = world.store.snapshotThread(threadId);
  expect(
    Object.values(state?.interactions ?? {}).filter(
      (each) => each.request.kind === "browser_help" && each.state === "pending",
    ),
  ).toEqual([]);
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("asking again about a tab whose request an interrupted turn cancelled opens a new one the person can answer", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  await world.startTurn(threadId);
  const first = Help.parse(
    (
      await agent.call("browser_request_help", {
        tabId,
        reason: "login",
        message: "Sign in",
        timeoutSeconds: 5,
      })
    ).data,
  );
  expect(first.status).toBe("pending");
  await world.interruptTurn(threadId);
  await world.flush();
  expect(world.store.snapshotThread(threadId)?.interactions).toSatisfy((all: object) =>
    Object.values(all).every((each: { state: string }) => each.state !== "pending"),
  );

  // No new run starts in between (another agent of the thread may still be running), so
  // nothing has withdrawn the old request's record yet.
  const again = agent.call("browser_request_help", { tabId, reason: "login", message: "Sign in" });
  const request = await openRequest(world, threadId);
  expect(request.id).not.toBe(first.requestId);
  expect(
    answer(world, request.id, "person", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: true });
  expect(Help.parse((await again).data)).toMatchObject({ status: "done", tabId });
});
