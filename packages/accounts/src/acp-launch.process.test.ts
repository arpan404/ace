import { expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountService, createAcpInstance, openRegistry } from "./index.ts";
import { AgentRegistry, AgentCatalog } from "@ace/agent-registry";
import { createAcpAdapter, genericQuirks } from "@ace/adapter-acp";
import { AcpIdentity, ThreadId } from "@ace/protocol";

test("account lifetime replacement retains the approved ACP artifact, environment and model selector", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-acp-launch-"));
  const accounts = await openRegistry(join(root, "accounts.sqlite"));
  const catalog = await AgentCatalog.open({
    cache: { load: async () => undefined, save: async () => {} },
    now: () => 1,
    target: "linux-x86_64",
    fetch: async () => {
      throw new Error("Offline");
    },
  });
  const agents = await AgentRegistry.open({
    catalog,
    root: join(root, "artifacts"),
    target: "linux-x86_64",
    env: {},
    storage: { load: async () => [], save: async () => {} },
  });
  const identity = AcpIdentity.parse({
    acpAgentId: "local:synthetic",
    installationId: "approved",
    instanceId: "approved:default",
  });
  try {
    await agents.bind({
      ...identity,
      version: "1.0.0",
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./testing/acp-server.ts", import.meta.url)),
        "--approved-artifact",
      ],
    });
    await accounts.register(createAcpInstance({ identity, label: "Synthetic", userHome: root }));
    const marker = join(root, "selected.json");
    const service = new AccountService({
      registry: accounts,
      env: { HOME: root, ACE_TEST_MARKER: marker },
      now: () => 1,
      timeZone: "UTC",
    });
    const adapter = createAcpAdapter(genericQuirks, {
      acceptsIdentity: (id) => agents.has(id),
      async resolveLaunch(context) {
        if (!context.acpLaunch)
          throw new Error("Immutable launch plan lost during account binding");
        return context.acpLaunch;
      },
    });
    const bound = service.bindAdapter({ ...adapter, create: () => adapter });
    const account = service.acpEnvironment(identity);
    const session = await bound.openSession({
      threadId: ThreadId.parse("synthetic"),
      cwd: root,
      acpIdentity: identity,
      acpLaunch: await agents.resolve(identity, account.env),
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    });
    try {
      expect(session.acpSupport).toMatchObject({ modelSelection: true, visibility: "limited" });
      await session.setModel?.("two");
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ selected: "two", home: root });
    } finally {
      await session.close("user");
    }
  } finally {
    await agents.close();
    accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});
