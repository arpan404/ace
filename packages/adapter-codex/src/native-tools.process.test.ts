import { expect, test } from "vitest";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

const aceMcp = { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) };
const fullAccess = accessModeOffers({ provider: "codex" }).find(
  (offer) => offer.mode === "full-access",
)?.native;

test("Full access starts Codex with danger-full-access and never-approve, and keeps its native tools and instructions", async () => {
  const h = await sessionHarness(false, "", undefined, undefined, aceMcp, fullAccess);
  try {
    const start = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "thread/start",
    );
    const params = obj(obj(start?.data).params);
    expect(params).toMatchObject({ permissions: ":danger-full-access", approvalPolicy: "never" });
    // ace's server is the only config it adds: shell, apply_patch, web search, multi-agent and
    // the person's config.toml (features, profiles, their MCP servers) stay as Codex has them.
    expect(Object.keys(obj(params.config))).toEqual(["mcp_servers.ace"]);
    // Codex's own base instructions stay; ace's guidance is developer instructions beside them.
    expect(params.baseInstructions).toBeUndefined();
    expect(String(params.developerInstructions)).not.toBe("");
    await h.session.send([{ type: "text", text: "running" }], "queue");
    const turn = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
    );
    expect(obj(obj(turn?.data).params)).toMatchObject({
      permissions: ":danger-full-access",
      approvalPolicy: "never",
    });
  } finally {
    await h.dispose();
  }
});
