import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation, DelegationRequest } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { GitService, spawnGitProcess } from "@ace/git";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { shellQuote } from "../workspace-scripts.ts";
import { repository } from "../thread-creation-test-support.ts";
import { createWorkspaceDelegations } from "./workspaces.ts";
import { setup } from "./test-support.ts";

test("restart during real Git preparation fences the obsolete child before its checkout can launch", async () => {
  const h = setup();
  await repository(h.home);
  const parent = await h.parent();
  const target = h.delegate(parent, "target");
  await h.engine.flush();
  const { promise: hostEntered, resolve: entered } = Promise.withResolvers<void>();
  const { promise: preparationEntered, resolve: preparing } = Promise.withResolvers<void>();
  let response: ServerResponse | undefined;
  const server = createServer((_request, reply) => {
    response = reply;
    entered();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server missing");
  await writeFile(
    join(h.home, "hold.cjs"),
    "require('node:http').get(process.argv[2], r => {r.resume(); r.on('end', () => process.exit(0));});\n",
  );
  const service = new GitService({
    processRuntime: {
      spawn: (command, args, options) => {
        if (args.includes("--get-regexp")) preparing();
        return spawnGitProcess(command, args, options);
      },
    },
  });
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now, {
    gitService: service,
  });
  const hostWork = runtime.git.setupWorktree({
    worktree: h.home,
    command: `${shellQuote(process.execPath)} hold.cjs http://127.0.0.1:${address.port}/hold`,
  });
  try {
    // A real, independently authorized host Git mutation holds the project's serial queue.
    await hostEntered;
    const port = createAgentControlPort(h.store, h.service, {
      delegateWorkspace: createWorkspaceDelegations(
        {
          store: h.store,
          services: { workspaceActions: runtime },
          signal: new AbortController().signal,
        },
        h.service,
      ),
    });
    const pending = port
      .execute(
        h.caller(target.childId),
        AgentControlOperation.parse({
          op: "delegate_task",
          requestId: "obsolete-worktree",
          task: "Obsolete task",
          role: "worker",
          provider: "claude",
          workspace: { kind: "new_worktree", base: { ref: "main" } },
        }),
        new AbortController().signal,
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await preparationEntered;
    expect(
      (
        await port.execute(
          parent,
          AgentControlOperation.parse({
            op: "thread.message",
            threadId: target.childId,
            requestId: "restart-pending",
            text: "Replacement task",
            delivery: "restart",
          }),
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    response?.end("Released");
    await hostWork;
    expect(await pending).toMatchObject({ error: expect.any(Error) });
    await h.engine.flush();
    expect(h.store.listThreads()).toHaveLength(2);
    expect(h.inputs.get(target.childId)?.at(-1)).toBe("Replacement task");
    expect(await runtime.git.listWorktrees(h.home)).toHaveLength(1);
  } finally {
    response?.end("Released");
    await hostWork.catch(() => {});
    await runtime.close();
    await service.close();
    server.close();
    await once(server, "close");
  }
});

test("an unwatched durable reservation cannot commit after restart even when the delegation owner reopens", async () => {
  const h = setup();
  const parent = await h.parent();
  const target = h.delegate(parent, "target");
  await h.engine.flush();
  const caller = h.caller(target.childId);
  const reservation = h.service.reserve(
    caller,
    DelegationRequest.parse({
      requestId: "durable-obsolete",
      task: "Obsolete",
      role: "worker",
      provider: "claude",
    }),
  );
  const port = createAgentControlPort(h.store, h.service);
  expect(
    (
      await port.execute(
        parent,
        AgentControlOperation.parse({
          op: "thread.message",
          threadId: target.childId,
          requestId: "restart-reserved",
          text: "Replacement",
          delivery: "restart",
        }),
        new AbortController().signal,
      )
    ).ok,
  ).toBe(true);
  await h.engine.flush();
  h.restartOwner();
  const workspace = h.store.getThread(target.childId)?.workspaceId;
  if (!workspace) throw new Error("Project missing");
  expect(() => h.service.prepareReserved(caller, reservation, workspace)).toThrow();
  expect(h.store.listThreads()).toHaveLength(2);
  expect(h.inputs.get(target.childId)?.at(-1)).toBe("Replacement");
  const accepted = h.delegate(caller, "fresh-after-restart");
  await h.engine.flush();
  expect(h.contexts.get(accepted.childId)?.threadId).toBe(accepted.childId);
});
