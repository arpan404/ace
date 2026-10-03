import { expect, test } from "vitest";
import { z } from "zod";
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
      options: { effort: "high" },
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
    });
    await h.session.send([{ type: "text", text: "continue native history" }], "queue");
    const input = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(input["session_id"]).toBe(nativeId);
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
      options: { permissionMode: "plan", effort: "high" },
      aceMcp: { url: "http://127.0.0.1:9012/mcp", bearer },
    },
  );
  try {
    const control = await h.wait(subtype("fake_control"));
    const data = object(control.data);
    expect(data["settings"]).toMatchObject({ permissionMode: "plan" });
    const argv = z.array(z.string()).parse(data["argv"]);
    expect(argv).toEqual(expect.arrayContaining(["--resume=source-native", "--fork-session"]));
    const config = argv[argv.indexOf("--mcp-config") + 1];
    if (!config) throw new Error("Expected native MCP configuration");
    expect(JSON.parse(config)).toMatchObject({
      mcpServers: {
        project: { url: "http://127.0.0.1:9011/mcp" },
        ace: {
          url: "http://127.0.0.1:9012/mcp",
          headers: { Authorization: "Bearer <ACE_MCP_CREDENTIAL>" },
        },
      },
    });
    expect(object(data["request"])["appendSystemPrompt"]).toContain("mcp__ace__*");
    expect(JSON.stringify(h.frames)).not.toContain(bearer);
  } finally {
    await h.session.close("shutdown");
  }
});
