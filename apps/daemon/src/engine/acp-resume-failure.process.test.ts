import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createAcpAdapter } from "@ace/adapter-acp";
import { fixture, cleanupRecovery, restart, dispatch, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);
const server = fileURLToPath(new URL("./acp-resume-error-server.ts", import.meta.url));
const cases = [
  { name: "unsupported loading", config: { load: false }, unavailable: true },
  {
    name: "a missing conversation transported as JSON-RPC",
    config: {
      load: true,
      failure: { code: -32000, message: "No conversation found for private-native-id" },
    },
    unavailable: true,
  },
  {
    name: "an unsupported load method transported as JSON-RPC",
    config: { load: true, failure: { code: -32601, message: "Method not found" } },
    unavailable: true,
  },
  {
    name: "an authoritative missing-session code transported as JSON-RPC",
    config: { load: true, failure: { code: "session_not_found", message: "Unavailable" } },
    unavailable: true,
  },
  {
    name: "a transient load error",
    config: {
      load: true,
      failure: { code: -32000, message: "Temporary handshake failure api_key=private-secret" },
    },
    unavailable: false,
  },
  {
    name: "a missing-conversation message during initialization",
    config: {
      load: true,
      initializeFailure: { code: -32000, message: "No conversation found for private-native-id" },
    },
    unavailable: false,
  },
];

test.each(cases)(
  "ACP $name keeps the input with the correct recovery guidance after restart",
  async ({ config, unavailable }) => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider: "acp",
    });
    const id = await h.create();
    h.registry.register(
      createAcpAdapter(undefined, {
        command: process.execPath,
        args: [server],
        env: { ACE_ACP_RESUME_ERROR: JSON.stringify(config) },
        acceptsIdentity: () => true,
      }),
      { installed: true, auth: "logged_in", loginHint: "" },
    );
    const engine = await restart(h);
    dispatch(h.store, engine, { type: "thread.send", threadId: id, input: text("keep my input") });
    await engine.flush();
    expect(engine.queue(id)).toMatchObject({
      paused: true,
      reason: "not_sent",
      pendingCount: 1,
      messages: [{ input: text("keep my input") }],
      lastFailure: { code: unavailable ? "resume_unavailable" : "delivery_failed" },
    });
    const title = engine.queue(id).lastFailure?.title;
    expect(title).toContain(unavailable ? "Start a new thread" : "try again");
    expect(title).not.toMatch(/private-native-id|private-secret|api_key|\{|JSON/);
    await engine.close();
    const reloaded = await restart({ ...h, engine });
    expect(reloaded.queue(id).lastFailure?.title).toBe(title);
    expect(reloaded.queue(id).messages).toMatchObject([{ input: text("keep my input") }]);
  },
);
