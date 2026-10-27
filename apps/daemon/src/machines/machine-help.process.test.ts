import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { Command } from "@ace/protocol";
import { invoke, Result } from "../browser-mcp-test-support.ts";
import { commandContext } from "../commands.ts";
import { pairedMachines } from "./machine-test-support.ts";

it("the person answers a real guest browser login request from the calling thread", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const { threadId, agentId } = pair.source.caller;
  const lease = pair.source.daemon.mcp.openSession(
    { sessionId: "remote-help", threadId, agentId, capabilities: ["browser"] },
    new AbortController().signal,
  );
  const connection = { url: pair.source.daemon.mcp.url, bearer: lease.bearer };
  const opened = Result.parse(
    await (
      await invoke(connection, "browser_open", {
        machine: "studio",
        url: "https://docs.example.test/login",
      })
    ).json(),
  ).result;
  expect(opened.isError).not.toBe(true);
  // Read the tab the production browser_open created in the guest session.
  const guest = pair.target.daemon.store.listThreads().find((thread) => thread.details?.guest);
  if (!guest) throw new Error("No guest session");
  const browser = pair.target.daemon.browser;
  if (!browser) throw new Error("No browser");
  const root = pair.target.daemon.engine?.rootAgent(guest.id);
  if (!root) throw new Error("No guest root");
  const tabId = browser.currentTab(guest.id, { kind: "agent", agentId: root }).tabId;
  const pending = pair.requestIn(
    pair.source,
    threadId,
    (interaction) => interaction.request.kind === "browser_help",
  );
  const helping = invoke(connection, "browser_request_help", {
    machine: "studio",
    tabId,
    reason: "login",
    message: "Sign in to the test account",
    timeoutSeconds: 30,
  });
  const mirrored = await Promise.race([
    pending,
    helping.then(async (response) => {
      throw new Error(
        `Help returned before asking the person: ${JSON.stringify(await response.clone().json())}`,
      );
    }),
  ]);
  expect(mirrored.request).toMatchObject({
    kind: "browser_help",
    target: { tool: "browser_request_help" },
  });
  const command = Command.parse({
    id: randomUUID(),
    deviceId: "person",
    payload: {
      type: "interaction.resolve",
      interactionId: mirrored.id,
      resolution: { kind: "browser_help", outcome: "done" },
    },
  });
  const engine = pair.source.daemon.engine;
  if (!engine) throw new Error("No engine");
  expect(
    pair.source.daemon.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, commandContext(pair.source.daemon.store)),
    ),
  ).toMatchObject({ ok: true });
  const result = Result.parse(await (await helping).json()).result;
  expect(result.isError).not.toBe(true);
  const text = result.content[0]?.text;
  expect(
    z.object({ status: z.literal("done"), tabId: z.string() }).parse(JSON.parse(text ?? "null")),
  ).toMatchObject({ status: "done", tabId });
});
