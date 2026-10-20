import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "./index.ts";
import type { AwarenessPort } from "./index.ts";
import { scope } from "./test-support.ts";

type Facts = NonNullable<ReturnType<AwarenessPort["facts"]>>;
const Session = z.object({
  brief: z.string(),
  facts: z.object({ liveSiblings: z.number(), branch: z.string().nullable() }),
});

test("a session's brief stays as first read while ace://session still reports live facts", async () => {
  const facts: Facts = {
    project: "shop",
    branch: "main",
    worktree: false,
    machine: null,
    access: "ask",
    liveSiblings: 0,
    children: [],
    pendingRequests: 0,
    notes: [],
  };
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  const server = await startMcpServer({
    registry: new ToolRegistry({ scheduler: nodeScheduler }),
    credentials,
    awareness: { facts: () => ({ ...facts }), delegates: () => [] },
  });
  onTestFinished(() => server.close());
  const lease = credentials.issue(scope(), new AbortController().signal);
  const client = new Client(
    { name: "test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  onTestFinished(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${lease.bearer}` } },
    }),
  );
  const read = async () => {
    const result = await client.readResource({ uri: "ace://session" });
    return Session.parse(JSON.parse(z.object({ text: z.string() }).parse(result.contents[0]).text));
  };
  const first = await read();
  expect(first.brief).toContain('branch "main"');
  Object.assign(facts, { branch: "feat/other", liveSiblings: 5, pendingRequests: 1 });
  const later = await read();
  expect(later.brief).toBe(first.brief);
  expect(later.facts).toMatchObject({ branch: "feat/other", liveSiblings: 5 });
});
