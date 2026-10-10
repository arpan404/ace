import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { AgentControlResult, LinkedPullRequest } from "@ace/protocol";
import { daemonFixture } from "./daemon-test-support.ts";

const listed = z.object({ linkedPrs: z.array(LinkedPullRequest) });
const execute = promisify(execFile);

async function callMcp(connection: { url: string; bearer: string }, name: string, args: unknown) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return z
    .object({
      result: z
        .object({
          structuredContent: AgentControlResult.optional(),
          isError: z.boolean().optional(),
        })
        .optional(),
      error: z.object({ code: z.number() }).optional(),
    })
    .parse(await response.json());
}

test("agent PR links appear live in thread details, deduplicate and can be removed singly or all at once", async () => {
  const f = await daemonFixture();
  try {
    await execute("git", ["init", "-q", f.h.home]);
    await execute("git", [
      "-C",
      f.h.home,
      "remote",
      "add",
      "origin",
      "https://github.com/test/project.git",
    ]);
    const connection = f.h.contexts.get(f.caller.threadId)?.aceMcp;
    if (!connection) throw new Error("Missing scoped MCP connection");
    expect(
      (await callMcp(connection, "ace_thread_link_pr", { number: 283 })).result?.structuredContent
        ?.ok,
    ).toBe(true);
    expect(
      (
        await callMcp(connection, "ace_thread_link_pr", {
          url: "https://github.com/test/project/pull/284",
        })
      ).result?.structuredContent?.ok,
    ).toBe(true);
    expect(
      (await callMcp(connection, "ace_thread_link_pr", { number: 283 })).result?.structuredContent
        ?.ok,
    ).toBe(true);
    const links = listed.parse((await f.call({ op: "thread.list_prs" })).data).linkedPrs;
    expect(links.map((link) => link.number)).toEqual([284, 283]);
    expect(links.every((link) => link.unverified === true)).toBe(true);
    expect(f.daemon.store.getThread(f.caller.threadId)?.details?.linkedPrs).toEqual(links);
    expect(
      (await f.call({ op: "thread.read", threadId: f.caller.threadId, limit: 1 })).data,
    ).toMatchObject({ linkedPrs: links });
    expect(
      (
        await callMcp(connection, "ace_thread_unlink_pr", {
          url: "https://github.com/test/project/pull/283",
        })
      ).result?.structuredContent?.ok,
    ).toBe(true);
    expect(
      listed
        .parse((await f.call({ op: "thread.list_prs" })).data)
        .linkedPrs.map((link) => link.number),
    ).toEqual([284]);
    expect(
      (await callMcp(connection, "ace_thread_unlink_pr", { all: true })).result?.structuredContent
        ?.ok,
    ).toBe(true);
    expect(listed.parse((await f.call({ op: "thread.list_prs" })).data).linkedPrs).toEqual([]);
    expect(f.daemon.store.getThread(f.caller.threadId)?.details?.linkedPrs).toEqual([]);
  } finally {
    await f.daemon.close();
  }
});

test("MCP PR operations reject thread selection and ambiguous targets without changing either thread's links", async () => {
  const f = await daemonFixture();
  try {
    const connection = f.h.contexts.get(f.caller.threadId)?.aceMcp;
    if (!connection) throw new Error("Missing scoped MCP connection");
    const childResult = await f.call({
      op: "thread.create",
      requestId: "pr-child",
      title: "child",
      provider: "claude",
    });
    const child = z.object({ threadId: z.string() }).parse(childResult.data);
    for (const [name, args] of [
      [
        "ace_thread_link_pr",
        { threadId: child.threadId, url: "https://github.com/test/project/pull/283" },
      ],
      ["ace_thread_link_pr", { url: "https://github.com/test/project/pull/283", number: 284 }],
      ["ace_thread_unlink_pr", { threadId: child.threadId, all: true }],
      ["ace_thread_unlink_pr", { number: 283, all: true }],
      ["ace_thread_list_prs", { threadId: child.threadId }],
    ] satisfies [string, unknown][]) {
      const result = await callMcp(connection, name, args);
      expect(result.error !== undefined || result.result?.isError === true).toBe(true);
    }
    expect(listed.parse((await f.call({ op: "thread.list_prs" })).data).linkedPrs).toEqual([]);
    expect(
      f.daemon.store
        .listThreads()
        .every((thread) => (thread.details?.linkedPrs?.length ?? 0) === 0),
    ).toBe(true);
  } finally {
    await f.daemon.close();
  }
});
