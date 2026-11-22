import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { grantPublicKey, policyBodySha256, signOrgRoster } from "@ace/account-grant";
import { DelegationRequest, McpAttribution, ThreadId } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { MachineCaller, type CallerDeps } from "../machines/caller.ts";
import type { MachineChildren } from "../machines/children.ts";
import type { MachineDirectory } from "../machines/directory.ts";
import type { Store } from "../store.ts";
import { MachineFailure } from "../machines/transport.ts";
import { sessionContainment } from "./containment.ts";
import { BackendUnreachable, memberWork } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";

/*
 * A member tree's delegation to another host whose answer never comes back (ADR 0209 §7): the
 * caller can't tell whether the child was made, so its tree's stop waits for the target to say.
 * One the target refused, or that was never sent, holds nothing. The other machine is stood in
 * for at the caller's directory; members' work runs on a real SQLite file.
 */

const org = "org_01ACME";
const host = "A".repeat(52);
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function roster(version: number, members: Record<string, string>) {
  const body = JSON.stringify({
    members: Object.entries(members).map(([account, status]) => ({
      account,
      status,
      role: "member",
    })),
    hosts: [{ id: host }],
  });
  return {
    body,
    statement: signOrgRoster(
      { org, host, epoch: 1, version, at: Date.now(), body_sha256: policyBodySha256(body) },
      key,
    ),
  };
}

function miasWork() {
  const dir = mkdtempSync(join(tmpdir(), "ace-remote-start-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "members.sqlite"));
  const work = memberWork({
    store: memberWorkStore({ atomic: (run) => run(db) }),
    org: () => org,
    host: () => host,
    fetchRoster: async () => {
      throw new BackendUnreachable("offline");
    },
    keys: () => ({ keys: [grantPublicKey(key)] }),
    stopTree: async () => "stopped",
    containment: sessionContainment,
    wall: Date.now,
    monotonic: () => performance.now(),
    delay: () => () => {},
    id: () => "start-1",
    resolveRemoteStart: async () => "unknown",
  });
  work.takeRoster(roster(1, { user_mia: "active" }));
  return work;
}

/** The caller, reaching the other machine through a directory that answers with `failure`. */
function callerFailing(failure: () => unknown) {
  const directory = {
    call: async () => {
      throw failure();
    },
    device: () => "desk-device",
    controlError: (_machine: string, error: unknown) => error,
  } as Partial<MachineDirectory> as MachineDirectory;
  const deps: Partial<CallerDeps> = {
    store: { getThread: () => undefined } as Partial<Store> as Store,
    hostId: "B".repeat(52),
    hostName: async () => "Host",
    directory,
    children: { byRequest: () => undefined } as Partial<MachineChildren> as MachineChildren,
    ceiling: () => "operate",
  };
  return new MachineCaller(deps as CallerDeps);
}

const caller = McpAttribution.parse({ sessionId: "s", threadId: "t_mia", agentId: "root" });
const request = DelegationRequest.parse({
  requestId: "remote-1",
  machine: "desk",
  provider: "codex",
  task: "Run it there",
  role: "remote",
});

async function delegatedThenStopped(failure: () => unknown) {
  const work = miasWork();
  expect(work.admit("user_mia", "t_mia")).toBe(true);
  const start = work.remoteStart("user_mia", "t_mia", JSON.stringify({ caller, request }));
  await expect(
    callerFailing(failure).delegate(caller, request, new AbortController().signal, start),
  ).rejects.toBeDefined();
  start?.notSent();
  work.takeRoster(roster(2, {}));
  await work.pass();
  return work.pendingStops();
}

it("a delegation whose answer was lost keeps its tree's stop waiting for the target", async () => {
  expect(await delegatedThenStopped(() => new MachineFailure("disconnected"))).toEqual([
    ThreadId.parse("t_mia"),
  ]);
});

it("a delegation the target refused, or that never left, holds no stop", async () => {
  expect(await delegatedThenStopped(() => new MachineFailure("refused", "unavailable"))).toEqual(
    [],
  );
  expect(await delegatedThenStopped(() => new MachineFailure("offline"))).toEqual([]);
});
