import { expect, test } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { object, array } from "./data.ts";
test("mid-message OpenCode skills and agents carry native identities and exact mention ranges", async () => {
  const h = await setup();
  await h.session.send(
    [
      { type: "text", text: "Use " },
      {
        type: "mention",
        entryId: "skill",
        kind: "skill",
        name: "review",
        arguments: "",
        invocation: { type: "skill", name: "review", path: "skill-one" },
      },
      { type: "text", text: " with " },
      {
        type: "mention",
        entryId: "agent",
        kind: "agent",
        name: "auditor",
        arguments: "",
        invocation: { type: "agent", name: "auditor" },
      },
    ],
    "queue",
  );
  const requests = array(await h.control("/test/requests")).map(object);
  const prompt = requests.find((r) => String(r.path).endsWith("/prompt"));
  expect(prompt?.body).toMatchObject({
    text: "Use /review with @auditor",
    skills: [{ id: "skill-one", mention: { start: 4, end: 11, text: "/review" } }],
    agents: [{ name: "auditor", mention: { start: 17, end: 25, text: "@auditor" } }],
  });
});
test("multiple OpenCode command chips use the native command endpoint with the complete message", async () => {
  const h = await setup();
  await h.session.send(
    [
      { type: "text", text: "Please " },
      {
        type: "mention",
        entryId: "one",
        kind: "command",
        name: "explain",
        arguments: "diff",
        invocation: { type: "slash", name: "native-explain" },
      },
      { type: "text", text: " and " },
      {
        type: "mention",
        entryId: "two",
        kind: "command",
        name: "check",
        arguments: "",
        invocation: { type: "slash", name: "native-check" },
      },
    ],
    "queue",
  );
  const requests = array(await h.control("/test/requests"))
    .map(object)
    .filter((r) => r.method === "POST" && String(r.path).endsWith("/command"));
  expect(requests.map((r) => r.body)).toMatchObject([
    {
      name: "native-explain",
      text: "Please /explain and /check\n\nCommand arguments: diff",
      delivery: "queue",
    },
    { name: "native-check", text: "Please /explain and /check", delivery: "queue" },
  ]);
});
test("a rejection after an earlier command was admitted reports uncertainty instead of rejection", async () => {
  const h = await setup();
  await expect(
    h.session.send(
      [
        {
          type: "mention",
          entryId: "one",
          kind: "command",
          name: "explain",
          arguments: "",
          invocation: { type: "slash", name: "native-explain" },
        },
        {
          type: "mention",
          entryId: "two",
          kind: "command",
          name: "reject",
          arguments: "",
          invocation: { type: "slash", name: "reject" },
        },
      ],
      "queue",
    ),
  ).rejects.toThrow("acknowledgement uncertain");
  expect(h.frames.some((f) => f.channel === "input.uncertain")).toBe(true);
  expect(h.frames.some((f) => f.channel === "input.rejected")).toBe(false);
});

test("OpenCode skill updates refresh metadata with new native identities and descriptions", async () => {
  const h = await setup();
  await h.seen((f) => f.channel === "catalog.runtime" && object(f.data).method === "skill.list");
  const from = h.frames.length;
  await h.control("/test/catalog", {
    skills: [
      {
        id: "new-skill",
        name: "deploy",
        path: "/one/.opencode/skills/deploy/SKILL.md",
        description: "Deploy safely",
      },
    ],
  });
  await h.publish("skill.updated");
  const metadata = await h.seen(
    (f) => f.channel === "catalog.runtime" && object(f.data).method === "skill.list",
    from,
  );
  expect(array(object(object(metadata.data).result).data)).toMatchObject([
    { id: "new-skill", name: "deploy", description: "Deploy safely" },
  ]);
});

test("OpenCode exposes connected MCP server metadata without inventing a tool identity", async () => {
  const h = await setup();
  const from = h.frames.length;
  await h.control("/test/catalog", { servers: ["docs"] });
  await h.publish("mcp.status.changed");
  const metadata = await h.seen(
    (f) => f.channel === "catalog.runtime" && object(f.data).method === "mcp.list",
    from,
  );
  expect(array(object(object(metadata.data).result).data)).toMatchObject([
    { name: "docs", status: "connected" },
  ]);
});
