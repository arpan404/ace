import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Frame, SessionContext } from "@ace/engine-api";
import { matchProfile } from "@ace/agent-registry";
import { openAcpSession, genericQuirks } from "./index.ts";
const server = fileURLToPath(new URL("./testing/negotiation-server.ts", import.meta.url));
const Envelope = z
  .object({ method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() })
  .passthrough();
async function open(
  config: Record<string, boolean>,
  context: Partial<SessionContext> = {},
  agent?: string,
  version?: string,
) {
  const frames: Frame[] = [];
  const exited = Promise.withResolvers<void>();
  const seen = Promise.withResolvers<void>();
  const profile = agent && version ? matchProfile(agent, version) : undefined;
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("synthetic"),
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onFrame(frame) {
        frames.push(frame);
        if (Envelope.safeParse(frame.data).data?.method === "session/update") seen.resolve();
      },
      onExit: () => exited.resolve(),
      ...context,
    },
    genericQuirks,
    {
      command: process.execPath,
      args: [server],
      env: { ACE_SYNTHETIC_ACP: JSON.stringify(config) },
      ...(profile ? { profile } : {}),
    },
  );
  return { session, frames, exited: exited.promise, seen: seen.promise };
}
test("load is negotiated before sending any resume request and legacy model selection follows the profile", async () => {
  const resume = { nativeSessionId: "synthetic-session" };
  await expect(
    open({ load: false, noSelectors: true }, { resume }, "qwen-code", "0.0.14"),
  ).rejects.toThrow("loading");
  const h = await open(
    { load: true, legacy: true },
    { resume, model: "model-a" },
    "gemini",
    "0.43.0",
  );
  try {
    expect(h.session.nativeSessionId).toBe("synthetic-session");
    expect(h.session.effectiveCapabilities).toMatchObject({
      resume: true,
      imageInput: true,
      planMode: true,
    });
    const methods = h.frames
      .filter((frame) => frame.dir === "send")
      .map((frame) => Envelope.parse(frame.data).method);
    expect(methods).toEqual(["initialize", "session/load", "session/set_model"]);
  } finally {
    await h.session.close("user");
  }
});
test("real config IDs and dependent replacements control later commands before the first prompt", async () => {
  const h = await open({}, { model: "model-a" });
  try {
    expect(h.session.acpSupport).toMatchObject({
      modelSelection: true,
      modeSelection: true,
      visibility: "limited",
      coverage: "generic",
    });
    await expect(h.session.setModel?.("model-a")).rejects.toThrow("unavailable");
    await h.session.setModel?.("model-b");
    await h.session.setMode?.("plan");
    expect(
      h.frames.some((frame) => Envelope.safeParse(frame.data).data?.method === "session/prompt"),
    ).toBe(false);
    const selector = h.frames.find(
      (frame) => Envelope.safeParse(frame.data).data?.method === "session/set_config_option",
    );
    expect(Envelope.parse(selector?.data).params).toMatchObject({ configId: "provider-model-id" });
  } finally {
    await h.session.close("user");
  }
});
test.each([false, true])(
  "MCP follows HTTP advertisement %s, preserves user servers and redacts lease echoes",
  async (http) => {
    const secret = "a".repeat(64);
    let ended = 0;
    let metadata: unknown;
    const h = await open(
      { http },
      {
        mcp: {
          configuredServers: [
            {
              name: "user",
              command: "/user/cli",
              args: [],
              env: [],
              [secret]: "secret-key-value",
              "[ace lease redacted]": "existing-key-value",
            },
          ],
          httpServers: [
            {
              name: "ace",
              type: "http",
              url: "http://127.0.0.1:1/mcp",
              headers: [{ name: "Authorization", value: `Bearer ${secret}` }],
            },
          ],
          stdioServers: [
            {
              name: "ace",
              command: process.execPath,
              args: ["bridge"],
              env: [{ name: "ACE_MCP_BRIDGE_BEARER", value: secret }],
            },
          ],
          secrets: [secret],
          end: () => {
            ended++;
          },
        },
        onSessionMetadata(value) {
          metadata = value;
        },
      },
    );
    try {
      expect(h.session.acpSupport?.mcp).toBe(http ? "http" : "stdio");
      const wire = h.frames.find(
        (frame) => Envelope.safeParse(frame.data).data?.method === "session/new",
      );
      expect(Envelope.parse(wire?.data).params?.mcpServers).toMatchObject([
        { name: "user" },
        { name: "ace", ...(http ? { type: "http" } : { command: process.execPath }) },
      ]);
      expect(JSON.stringify(h.frames)).not.toContain(secret);
      expect(JSON.stringify(h.frames.map((frame) => frame.payload?.data))).not.toContain(secret);
      expect(JSON.stringify(metadata)).not.toContain(secret);
      expect(JSON.stringify(metadata)).toContain("secret-key-value");
      expect(JSON.stringify(metadata)).toContain("existing-key-value");
      expect(JSON.stringify(h.frames)).toContain("secret-key-value");
    } finally {
      await h.session.close("user");
    }
    expect(ended).toBeGreaterThan(0);
  },
);
test("MCP name collisions and startup failures revoke the lease", async () => {
  let ended = false;
  await expect(
    open(
      {},
      {
        mcp: {
          configuredServers: [{ name: "ace" }],
          httpServers: [],
          stdioServers: [{ name: "ace", command: "bridge" }],
          secrets: [],
          end: () => {
            ended = true;
          },
        },
      },
    ),
  ).rejects.toThrow("collision");
  expect(ended).toBe(true);
});
test("unknown updates and vendor requests survive without SDK closure and final shutdown facts drain", async () => {
  const h = await open({});
  try {
    await h.session.send([{ type: "text", text: "synthetic" }], "queue");
    await h.seen;
    expect(JSON.stringify(h.frames)).toContain("future_update");
    expect(JSON.stringify(h.frames)).toContain("vendor/unknown");
    await h.session.close("user");
    await h.exited;
    expect(JSON.stringify(h.frames)).toContain("future_shutdown");
  } finally {
    await h.session.close("user");
  }
});
test("permission request floods terminate the owned process without admitting an unbounded wait set", async () => {
  const exited = Promise.withResolvers<void>();
  const frames: Frame[] = [];
  let session: import("@ace/engine-api").ProviderSession | undefined;
  try {
    try {
      const h = await open(
        { flood: true },
        {
          onFrame(frame) {
            frames.push(frame);
          },
          onExit() {
            exited.resolve();
          },
        },
      );
      session = h.session;
    } catch {
      // The burst can interrupt any negotiation step. The transport fault and final
      // process facts below establish why opening failed, without depending on that step.
    }
    await exited.promise;
    expect(JSON.stringify(frames)).toContain("request limit");
    expect(JSON.stringify(frames)).toContain("future_shutdown");
    if (session)
      await expect(session.send([{ type: "text", text: "never sent" }], "queue")).rejects.toThrow(
        "closed",
      );
  } finally {
    await session?.close("user");
  }
});

test("old Qwen restrictions override claimed load, selectors and HTTP MCP", async () => {
  const h = await open(
    { http: true, load: true },
    {
      mcp: {
        httpServers: [{ name: "ace", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] }],
        stdioServers: [{ name: "ace", command: "synthetic-bridge", args: [], env: [] }],
        secrets: [],
        end() {},
      },
    },
    "qwen-code",
    "0.0.14",
  );
  try {
    expect(h.session.acpSupport).toMatchObject({
      capabilities: { resume: false },
      mcp: "stdio",
      modelSelection: false,
      modeSelection: false,
    });
    await expect(h.session.setModel?.("model-a")).rejects.toThrow("unavailable");
    await expect(h.session.setMode?.("plan")).rejects.toThrow("unavailable");
    expect(
      h.frames
        .filter((frame) => frame.dir === "send")
        .map((frame) => Envelope.parse(frame.data).method),
    ).toEqual(["initialize", "session/new"]);
  } finally {
    await h.session.close("user");
  }
});

test.each(["failInitialize", "failSession"])(
  "%s startup failure revokes the MCP lease",
  async (failure) => {
    let revoked = false;
    await expect(
      open(
        { [failure]: true },
        {
          mcp: {
            httpServers: [],
            stdioServers: [],
            secrets: [],
            end() {
              revoked = true;
            },
          },
        },
      ),
    ).rejects.toThrow("Synthetic startup failure");
    expect(revoked).toBe(true);
  },
);
test("synchronous spawn failure revokes the lease before surfacing the error", async () => {
  let revoked = false;
  await expect(
    openAcpSession(
      {
        threadId: ThreadId.parse("spawn-failure"),
        cwd: process.cwd(),
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
        mcp: {
          httpServers: [],
          secrets: [],
          end() {
            revoked = true;
          },
        },
      },
      genericQuirks,
      { command: "synthetic", args: [] },
      {
        spawn() {
          throw new Error("Synthetic spawn failure");
        },
        now: () => 1,
      },
    ),
  ).rejects.toThrow("Synthetic spawn failure");
  expect(revoked).toBe(true);
});
test.each(["claude-acp", "codex-acp"])(
  "%s child sessions require bilateral profile negotiation",
  async (agent) => {
    const version = agent === "claude-acp" ? "0.85.1" : "2.1.1";
    for (const advertisement of ["canonical", "meta", "absent"]) {
      const advertised = advertisement !== "absent";
      const h = await open(
        { subagents: advertisement === "canonical", airSubagents: advertisement === "meta" },
        {},
        agent,
        version,
      );
      try {
        const initialize = h.frames.find(
          (frame) => Envelope.safeParse(frame.data).data?.method === "initialize",
        );
        expect(Envelope.parse(initialize?.data).params?.clientCapabilities).toMatchObject({
          subagents: {},
          _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } },
        });
        expect(h.session.acpSupport).toMatchObject({
          subagentSessions: advertised,
          visibility: "limited",
          coverage: "source_profile",
        });
        expect(h.session.effectiveCapabilities?.subagentTranscripts).toBe(advertised);
      } finally {
        await h.session.close("user");
      }
    }
    const generic = await open({ subagents: true });
    try {
      expect(generic.session.acpSupport?.subagentSessions).toBe(false);
      expect(generic.session.effectiveCapabilities?.subagentTranscripts).toBe(false);
    } finally {
      await generic.session.close("user");
    }
  },
);

test("ACP receives ace routing context on native prompts after opening and resuming", async () => {
  for (const resume of [undefined, { nativeSessionId: "synthetic-session" }]) {
    const h = await open(
      { load: true },
      {
        ...(resume ? { resume } : {}),
        mcp: { httpServers: [], stdioServers: [], secrets: [], end() {} },
      },
    );
    try {
      await h.session.send([{ type: "text", text: "Inspect localhost" }], "queue");
      const request = h.frames.find(
        (frame) =>
          frame.dir === "send" && Envelope.safeParse(frame.data).data?.method === "session/prompt",
      );
      const prompt = Envelope.parse(request?.data).params?.prompt;
      expect(prompt).toEqual(
        expect.arrayContaining([
          {
            type: "text",
            text: expect.stringContaining("Never drive Safari/Chrome/Arc/Firefox with screen_*"),
          },
          { type: "text", text: "Inspect localhost" },
        ]),
      );
    } finally {
      await h.session.close("shutdown");
    }
  }
});
