import { z } from "zod";
import { expect, test } from "vitest";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";

test("Claude forks at the exact native message with a distinct session identity", async () => {
  const source = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9da9";
  const message = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9daa";
  const h = await harness(
    undefined,
    "root",
    {},
    {
      fork: { nativeSessionId: source, point: { type: "item", nativeId: message } },
    },
  );
  try {
    const control = await h.wait(subtype("fake_control"));
    expect(object(control.data)["argv"]).toEqual(
      expect.arrayContaining([
        `--resume=${source}`,
        "--fork-session",
        `--resume-session-at=${message}`,
      ]),
    );
    expect(h.session.nativeSessionId).not.toBe(source);
    await h.session.send([{ type: "text", text: "continue branch" }], "queue");
    const input = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(input["session_id"]).toBe(h.session.nativeSessionId);
  } finally {
    await h.session.close("shutdown");
  }
});

test("Claude changes model and effort without replacing its native session", async () => {
  const h = await harness();
  try {
    const nativeId = h.session.nativeSessionId;
    if (!h.session.configure) throw new Error("Live configuration is required");
    await h.session.configure({
      provider: "claude",
      model: "next-model",
      options: { effort: "high", serviceTier: "fast" },
    });
    const model = await h.wait(
      (f) =>
        subtype("fake_control")(f) && object(object(f.data)["request"])["subtype"] === "set_model",
    );
    expect(object(object(model.data)["request"])["model"]).toBe("next-model");
    const flags = await h.wait(
      (f) =>
        subtype("fake_control")(f) &&
        object(object(f.data)["request"])["subtype"] === "apply_flag_settings",
    );
    expect(object(object(flags.data)["request"])["settings"]).toMatchObject({
      effortLevel: "high",
      fastMode: true,
    });
    await h.session.send([{ type: "text", text: "continue native history" }], "queue");
    const input = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(input["session_id"]).toBe(nativeId);
    const before = h.frames.length;
    await h.session.configure({
      provider: "claude",
      model: "next-model",
      options: {},
    });
    const reset = h.frames
      .slice(before)
      .find(
        (f) =>
          subtype("fake_control")(f) &&
          object(object(f.data)["request"])["subtype"] === "apply_flag_settings",
      );
    expect(object(object(reset?.data)["request"])["settings"]).toMatchObject({
      effortLevel: null,
      fastMode: false,
    });
  } finally {
    await h.session.close("shutdown");
  }
});

test("Claude retains both user MCP servers and a lifetime-scoped ace lease", async () => {
  const h = await harness(
    undefined,
    "root",
    {
      mcpServers: { user: { type: "http", url: "http://127.0.0.1:23456/mcp" } },
    },
    {
      options: { effort: null },
      aceMcp: {
        url: "http://127.0.0.1:12345/mcp",
        bearer: "a".repeat(64),
        signal: new AbortController().signal,
        end: () => {},
      },
    },
  );
  try {
    const status = await h.session.mcp?.status();
    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ace", status: "connected" }),
        expect.objectContaining({ name: "user", status: "connected" }),
      ]),
    );
    await h.session.send([{ type: "text", text: "continue with scoped tools" }], "queue");
    await h.wait(subtype("fake_input"));
    expect(JSON.stringify(h.frames)).not.toContain("a".repeat(64));
  } finally {
    await h.session.close("shutdown");
  }
});

test("Claude preserves selected fork permissions, project MCP and scoped ace instructions together", async () => {
  const bearer = "a".repeat(64);
  const h = await harness(
    undefined,
    "root",
    {
      mcpServers: { project: { type: "http", url: "http://127.0.0.1:9011/mcp" } },
    },
    {
      fork: { nativeSessionId: "source-native", point: { type: "end", nativeId: "source-end" } },
      permissionMode: "auto",
      options: { effort: "high" },
      aceMcp: { url: "http://127.0.0.1:9012/mcp", bearer },
    },
  );
  try {
    const control = await h.wait(subtype("fake_control"));
    const data = object(control.data);
    expect(data["settings"]).toMatchObject({ permissionMode: "auto" });
    const argv = z.array(z.string()).parse(data["argv"]);
    expect(argv).toEqual(expect.arrayContaining(["--resume=source-native", "--fork-session"]));
    expect(data["mcpServers"]).toMatchObject({
      project: { url: "http://127.0.0.1:9011/mcp" },
      ace: {
        url: "http://127.0.0.1:9012/mcp",
        headers: { Authorization: "Bearer <ACE_MCP_CREDENTIAL>" },
      },
    });
    expect(object(data["request"])["appendSystemPrompt"]).toContain("mcp__ace__*");
    expect(object(data["request"])["appendSystemPrompt"]).toContain(
      "Never drive Safari/Chrome/Arc/Firefox with screen_*",
    );
    expect(object(data["request"])["appendSystemPrompt"]).not.toContain(
      "appear only when authorized",
    );
    expect(JSON.stringify(h.frames)).not.toContain(bearer);
  } finally {
    await h.session.close("shutdown");
  }
});
