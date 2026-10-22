import { expect, it } from "vitest";
import { harness, definition } from "./service-test-support.ts";

const run = (requestId: string, message?: string) => ({
  type: "automation.run" as const,
  requestId,
  id: "triage",
  variables: { subject: "issues" },
  ...(message ? { message } : {}),
});

it("a run starts on the automation's effort and account", async () => {
  const h = harness();
  h.service.put(definition({ effort: "high", instance: "codex_work" }));
  expect(h.service.handle(run("start")).ok).toBe(true);
  expect(await h.nextExecution(0)).toMatchObject({
    model: "test-model",
    effort: "high",
    instance: "codex_work",
  });
  await h.finish();
});

it("a run without effort or account leaves both to the provider's defaults", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.handle(run("start"));
  const input = await h.nextExecution(0);
  expect(input.effort).toBeUndefined();
  expect(input.instance).toBeUndefined();
  await h.finish();
});

it("a run note follows the saved prompt after a blank line", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.handle(run("noted", "Only look at the checkout flow"));
  expect((await h.nextExecution(0)).prompt).toBe("Triage issues\n\nOnly look at the checkout flow");
  await h.finish();
});

it("a note is taken as written, without filling trigger variables", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.handle(run("literal", "Leave {{subject}} alone"));
  expect((await h.nextExecution(0)).prompt).toBe("Triage issues\n\nLeave {{subject}} alone");
  await h.finish();
});

it("a retried noted run with the same request id starts once", async () => {
  const h = harness();
  h.service.put(definition({ concurrency: 4 }));
  const first = h.service.handle(run("same-intent", "First note"));
  const retry = h.service.handle(run("same-intent", "First note"));
  expect(retry.run?.id).toBe(first.run?.id);
  expect(h.inputs).toHaveLength(1);
  await h.finish();
  const later = h.service.handle(run("same-intent", "First note"));
  expect(later.run?.id).toBe(first.run?.id);
  expect(h.inputs).toHaveLength(1);
});

it("a note that would push the prompt past the message limit fails the run instead", async () => {
  const h = harness();
  h.service.put(definition({ prompt: "x".repeat(256 * 1024 - 4) }));
  const result = h.service.handle(run("too-long", "longer"));
  expect(result.run?.status).toBe("failed");
  expect(h.inputs).toEqual([]);
});
