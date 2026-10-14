import { expect, test } from "vitest";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createPiAdapter } from "@ace/adapter-pi";
import type { AccessMode } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const codex = (permissions: string, approvalPolicy: string, approvalsReviewer: string) =>
  JSON.stringify({ permissions, approvalPolicy, approvalsReviewer });
/** Each provider's genuinely supported modes and the exact native setting each one sends. */
const providers: {
  adapter: Pick<import("@ace/engine-api").ProviderAdapter, "provider" | "capabilities">;
  version: string;
  natives: Partial<Record<AccessMode, string>>;
}[] = [
  {
    adapter: createClaudeAdapter(),
    version: "2.1.286",
    natives: {
      "read-only": "plan",
      ask: "default",
      "auto-review": "auto",
      "full-access": "bypassPermissions",
    },
  },
  {
    adapter: createCodexAdapter(),
    version: "0.159.1",
    natives: {
      "read-only": codex(":read-only", "never", "user"),
      ask: codex(":read-only", "on-request", "user"),
      "auto-review": codex(":workspace", "on-request", "auto_review"),
      "full-access": codex(":danger-full-access", "never", "user"),
    },
  },
  {
    adapter: createOpenCodeAdapter(),
    version: "2.0.22",
    natives: { "read-only": "plan+ace", ask: "build+ask", "full-access": "build+allow" },
  },
  {
    adapter: createCursorAdapter(),
    version: "1.0.35",
    natives: {
      "auto-review": '{"sandboxOptions":{"enabled":true},"autoReview":true}',
      "full-access": '{"sandboxOptions":{"enabled":false},"autoReview":false}',
    },
  },
  {
    adapter: createPiAdapter(),
    version: "0.85.1",
    natives: { "read-only": "tools:read,grep,find,ls", "full-access": "unrestricted" },
  },
];
const cases = providers.flatMap(({ adapter, version, natives }) =>
  Object.entries(natives).map(([mode, native]) => ({
    provider: adapter.provider,
    adapter,
    version,
    mode: mode as AccessMode,
    native,
  })),
);

async function providerHarness(
  adapter: (typeof providers)[number]["adapter"],
  version: string,
  steps = 1,
) {
  const frames = scriptFrames();
  return harness(
    Array.from({ length: steps }, () => ({
      on: "send" as const,
      frames: [frames.frame(start, end)],
    })),
    frames,
    {
      provider: adapter.provider,
      capabilities: adapter.capabilities({
        installed: true,
        version,
        auth: "logged_in",
        loginHint: "unused",
      }),
    },
  );
}

test.each(cases)(
  "$provider runs $mode with exactly $native",
  async ({ adapter, version, mode, native }) => {
    const h = await providerHarness(adapter, version);
    try {
      const result = h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: adapter.provider,
        access: mode,
        input: [{ type: "text", text: "fake" }],
      });
      expect(result.ok).toBe(true);
      await h.engine.flush();
      expect(h.contexts[0]?.permissionMode).toBe(native);
      if (!result.threadId) throw new Error("No thread");
      expect(h.store.getThread(result.threadId)?.permission?.effective).toBe(mode);
      expect(Object.values(h.store.snapshotThread(result.threadId).runs)[0]).toMatchObject({
        provider: adapter.provider,
        permissionMode: mode,
      });
    } finally {
      await h.close();
    }
  },
);

test.each(providers)(
  "$adapter.provider lists only the modes it genuinely supports",
  async ({ adapter, version, natives }) => {
    const h = await providerHarness(adapter, version, 0);
    try {
      const client = await h.connect("preview");
      client.send({
        type: "permissions.capabilities",
        requestId: "catalog",
        provider: adapter.provider,
      });
      const reply = await client.next();
      if (reply.type !== "permissions.capabilities.result") throw new Error("Missing catalog");
      expect(reply.accessModes?.map((offer) => offer.mode)).toEqual(Object.keys(natives));
    } finally {
      await h.close();
    }
  },
);

test.each([
  { adapter: createOpenCodeAdapter(), version: "2.0.22", mode: "auto-review" as const },
  { adapter: createCursorAdapter(), version: "1.0.35", mode: "ask" as const },
  { adapter: createPiAdapter(), version: "0.85.1", mode: "ask" as const },
])(
  "$adapter.provider refuses an explicit $mode it doesn't support",
  async ({ adapter, version, mode }) => {
    const h = await providerHarness(adapter, version, 0);
    try {
      expect(
        h.command({
          type: "thread.create",
          workspaceId: h.workspace,
          provider: adapter.provider,
          access: mode,
          input: [{ type: "text", text: "fake" }],
        }),
      ).toMatchObject({ ok: false, error: "permission_mode_unsupported" });
      expect(h.store.listThreads()).toHaveLength(0);
    } finally {
      await h.close();
    }
  },
);

test("Pi's access modes are readable before its adapter is admitted", async () => {
  const h = await harness([], scriptFrames());
  try {
    const client = await h.connect("preview");
    client.send({ type: "permissions.capabilities", requestId: "pi-native", provider: "pi" });
    const reply = await client.next();
    expect(reply).toMatchObject({ type: "permissions.capabilities.result", ok: true });
    if (reply.type !== "permissions.capabilities.result") throw new Error("Missing reply");
    expect(reply.accessModes?.map((offer) => offer.mode)).toEqual(["read-only", "full-access"]);
  } finally {
    await h.close();
  }
});
