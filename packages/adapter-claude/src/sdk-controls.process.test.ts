import { expect, test, vi } from "vitest";
import { harness, subtype } from "./session.test-helper.ts";
import { createTranslator } from "./index.ts";
import { object } from "./native.ts";
for (const kind of ["form", "url"] as const)
  test(`${kind} elicitation stays pending until one typed answer reaches the provider`, async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: kind }], "queue");
      const request = await h.wait((f) => f.channel === "elicitation" && f.dir === "recv");
      const data = object(request.data);
      expect(object(data["request"])).toMatchObject({
        kind: "elicitation",
        mode: kind,
        server: "project-tools",
      });
      const id = String(data["requestId"]);
      if (kind === "form")
        await expect(
          h.session.resolve(id, { kind: "elicitation", action: "accept", content: { color: {} } }),
        ).rejects.toThrow();
      const answer = {
        kind: "elicitation" as const,
        action: "accept" as const,
        ...(kind === "form" ? { content: { color: "blue" } } : {}),
      };
      await h.session.resolve(id, answer);
      await expect(h.session.resolve(id, answer)).rejects.toThrow("no longer pending");
      const native = object(
        object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
      );
      expect(native).toEqual({
        action: "accept",
        ...(kind === "form" ? { content: { color: "blue" } } : {}),
      });
    } finally {
      await h.session.close("shutdown");
    }
  });

test("closing a Claude process expires its elicitation without recording a user cancellation", async () => {
  const h = await harness();
  await h.session.send([{ type: "text", text: "form" }], "queue");
  const request = await h.wait((f) => f.channel === "elicitation" && f.dir === "recv");
  await h.session.close("shutdown");
  const id = String(object(request.data)["requestId"]);
  expect(h.frames.find((f) => f.channel === "interaction_lifecycle")?.data).toEqual({
    requestId: id,
    state: "expired",
  });
  await expect(h.session.resolve(id, { kind: "elicitation", action: "accept" })).rejects.toThrow(
    "closed",
  );
});

test("native MCP replacements preserve settings and plugin servers and expose connection errors", async () => {
  const h = await harness(undefined, "root", {
    mcpServers: { initial: { type: "http", url: "http://127.0.0.1:12345/mcp" } },
  });
  try {
    const mcp = h.session.mcp;
    if (!mcp) throw new Error("Claude MCP control missing");
    expect(object((await h.wait(subtype("fake_control"))).data)["argv"]).toEqual(
      expect.arrayContaining(["--mcp-config"]),
    );
    await mcp.replace({ dynamic: { type: "http", url: "http://127.0.0.1:12345/mcp" } });
    expect(await mcp.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "dynamic", source: "dynamic" }),
        expect.objectContaining({
          name: "project-tools",
          source: "project",
          tools: [{ name: "read" }],
          future: 42,
        }),
      ]),
    );
    await mcp.replace({});
    expect(await mcp.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "plugin" }),
        expect.objectContaining({ source: "project" }),
      ]),
    );
    await mcp.disable("plugin-tools");
    await mcp.enable("plugin-tools");
    await mcp.reconnect("project-tools");
    const controls = h.frames
      .filter(subtype("fake_control"))
      .map((f) => object(object(f.data)["request"]));
    expect(controls).toEqual(
      expect.arrayContaining([
        { subtype: "mcp_toggle", serverName: "plugin-tools", enabled: false },
        { subtype: "mcp_toggle", serverName: "plugin-tools", enabled: true },
        { subtype: "mcp_reconnect", serverName: "project-tools" },
      ]),
    );
    await expect(mcp.replace({ broken: { command: "missing" } })).rejects.toThrow(
      "connection refused",
    );
    expect(
      h.frames.some(
        (f) => object(object(object(f.data)["response"])["response"])["future"] === "retained",
      ),
    ).toBe(true);
  } finally {
    await h.session.close("shutdown");
  }
});

test("an unsupported native dialog returns cancellation without opening human work", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "dialog" }], "queue");
    const response = object(
      object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
    );
    expect(response).toEqual({ behavior: "cancelled" });
    const translator = createTranslator({ rootKey: "root" });
    const facts = h.frames.flatMap((frame) => translator.translate(frame, frame.t));
    expect(facts.some((fact) => fact.type === "interaction.opened")).toBe(false);
  } finally {
    await h.session.close("shutdown");
  }
});

for (const configuration of [
  {
    kind: "coding" as const,
    settingSources: ["project" as const, "local" as const],
    permissionMode: "plan" as const,
  },
  { kind: "isolated" as const, permissionMode: "dontAsk" as const },
])
  test(`${configuration.kind} configuration delivers its chosen settings and explicit permission mode`, async () => {
    const h = await harness(undefined, "root", { configuration });
    try {
      const argv = object((await h.wait(subtype("fake_control"))).data)["argv"];
      expect(argv).toEqual(
        expect.arrayContaining([
          "--permission-mode",
          configuration.permissionMode,
          "--setting-sources",
          configuration.kind === "coding" ? "project,local" : "",
        ]),
      );
      expect(h.frames.some((f) => f.dir === "send" && object(f.data)["type"] === "user")).toBe(
        false,
      );
    } finally {
      await h.session.close("shutdown");
    }
  });

for (const suppressed of [false, true])
  test(`a native permission ${suppressed ? "rejects suppressed grants" : "returns every offered permission update"}`, async () => {
    const h = await harness();
    try {
      await h.session.send(
        [{ type: "text", text: suppressed ? "permission-suppressed" : "permission-meta" }],
        "queue",
      );
      const request = await h.wait((f) => f.channel === "can_use_tool" && f.dir === "recv");
      const options = object(object(request.data)["options"]);
      const id = String(options["requestId"]);
      expect(options).toMatchObject({
        title: "Claude wants to edit fake.ts",
        description: "Write access",
        defaultToNo: true,
        suppressAlwaysAllowRule: suppressed,
        mcpServer: { source: "project" },
      });
      if (suppressed) {
        await expect(
          h.session.resolve(id, { kind: "approval", optionId: "allow_updates" }),
        ).rejects.toThrow("Unknown");
        await h.session.resolve(id, { kind: "approval", optionId: "deny" });
      } else await h.session.resolve(id, { kind: "approval", optionId: "allow_updates" });
      const response = object(
        object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
      );
      expect(response["updatedPermissions"]).toEqual(
        suppressed
          ? undefined
          : [
              { type: "setMode", mode: "acceptEdits", destination: "session" },
              {
                type: "addDirectories",
                directories: ["/tmp/tools"],
                destination: "projectSettings",
              },
            ],
      );
    } finally {
      await h.session.close("shutdown");
    }
  });

test("a failed Claude cascade still attempts remaining live tasks and reports the failure", async () => {
  const h = await harness(undefined, "root", { env: { ACE_FAKE_STOP_TASK: "child-one" } });
  try {
    await h.session.send([{ type: "text", text: "tasks" }], "queue");
    await h.wait((f) => object(f.data)["task_id"] === "shell-one");
    await expect(h.session.interrupt({ cascade: true })).rejects.toThrow("every requested task");
    expect(h.frames.some((f) => object(object(f.data)["request"])["task_id"] === "shell-one")).toBe(
      true,
    );
  } finally {
    await h.session.close("shutdown");
  }
});

test("the SDK callback survives more than a minute while child progress and controls continue", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    h = await harness();
    await h.session.send([{ type: "text", text: "form" }], "queue");
    const request = await h.wait(
      (frame) => frame.channel === "elicitation" && frame.dir === "recv",
    );
    vi.advanceTimersByTime(120_000);
    await h.session.mcp?.status();
    await h.wait((frame) => object(object(frame.data)["message"])["id"] === "waiting-progress");
    const translator = createTranslator({ rootKey: "root" });
    const facts = h.frames.flatMap((frame) => translator.translate(frame, frame.t));
    expect(facts.some((fact) => fact.type === "interaction.closed")).toBe(false);
    expect(
      facts.some(
        (fact) =>
          fact.type === "item.upsert" &&
          fact.draft.type === "message" &&
          JSON.stringify(fact.draft).includes("Progress while you decide"),
      ),
    ).toBe(true);
    await h.session.resolve(String(object(request.data)["requestId"]), {
      kind: "elicitation",
      action: "accept",
      content: { color: "blue" },
    });
    const native = object(
      object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
    );
    expect(native).toEqual({ action: "accept", content: { color: "blue" } });
  } finally {
    vi.useRealTimers();
    await h?.session.close("shutdown");
  }
});

test("completed task churn releases control capacity while a later shell still stops", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "task-churn" }], "queue");
    await h.wait((frame) => object(frame.data)["task_id"] === "live-after-churn");
    await h.session.interrupt({ cascade: true });
    expect(
      h.frames.some(
        (frame) => object(object(frame.data)["request"])["task_id"] === "live-after-churn",
      ),
    ).toBe(true);
  } finally {
    await h.session.close("shutdown");
  }
});

test("excess live task admission ends the provider visibly rather than evicting work", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "task-capacity" }], "queue");
    expect(await h.exit).toMatchObject({
      deliberate: false,
      message: expect.stringContaining("live task capacity reached"),
    });
    expect(h.frames.some((frame) => object(frame.data)["task_id"] === "live-512")).toBe(true);
    await expect(h.session.send([{ type: "text", text: "later" }], "queue")).rejects.toThrow(
      "closed",
    );
  } finally {
    await h.session.close("shutdown");
  }
});

for (const scenario of ["completed-ancestor", "late-descendant"])
  test(`a targeted cascade reaches descendants through completed ancestry in ${scenario}`, async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: scenario }], "queue");
      await h.wait(subtype("ancestry-ready"));
      await h.session.interrupt({ agent: "ancestor", cascade: true });
      expect(
        h.frames.some((frame) => object(object(frame.data)["request"])["task_id"] === "descendant"),
      ).toBe(true);
    } finally {
      await h.session.close("shutdown");
    }
  });
