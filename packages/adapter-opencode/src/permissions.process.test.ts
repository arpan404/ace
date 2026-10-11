import { expect, test } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";

test.each(["build", "plan"] as const)(
  "OpenCode selects its native %s agent without replacing rules on launch or resume",
  async (mode) => {
    const h = await setup();
    const source = await h.open("/two", undefined, mode);
    const native = source.nativeSessionId;
    await source.close("idle");
    const rules = [
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "shell", resource: "git push *", effect: "deny" },
    ];
    await h.control("/test/state", {
      sessions: [
        {
          id: native,
          projectID: "project-one",
          agent: "build",
          permissions: rules,
          location: { directory: "/two" },
          time: { created: 1, updated: 1, idle: 1 },
        },
      ],
    });
    const resumed = await h.open("/two", native, mode);
    try {
      const requests = array(await h.control("/test/requests")).map(object);
      const create = requests.find(
        (r) => r.path === "/api/session" && object(object(r.body).location).directory === "/two",
      );
      expect(object(create?.body).agent).toBe(mode);
      expect(object(create?.body).permissions).toBeUndefined();
      const transport = h.transport();
      const response = await fetch(`${transport.url}/api/session/${native}`, {
        headers: { authorization: transport.authorization },
      });
      const info = object(object(await response.json()).data);
      expect(info.agent).toBe(mode);
      expect(info.permissions).toEqual(rules);
    } finally {
      await resumed.close("shutdown");
    }
  },
);

test("OpenCode leaves its default agent and mixed rules untouched when no mode is chosen", async () => {
  const h = await setup();
  const source = await h.open("/two");
  const native = source.nativeSessionId;
  await source.close("idle");
  const resumed = await h.open("/two", native);
  try {
    const requests = array(await h.control("/test/requests")).map(object);
    const create = requests.find(
      (r) => r.path === "/api/session" && object(object(r.body).location).directory === "/two",
    );
    expect(object(create?.body).agent).toBeUndefined();
    expect(object(create?.body).permissions).toBeUndefined();
    expect(requests.some((r) => r.path === `/api/session/${native}/agent`)).toBe(false);
    expect(requests.some((r) => r.path === `/api/session/${native}` && r.method === "PATCH")).toBe(
      false,
    );
  } finally {
    await resumed.close("shutdown");
  }
});
