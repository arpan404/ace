import { describe, expect, it } from "vitest";
import { runDeploy, type RunDeps, type RunInput, type WorkerPort } from "./deploy-run.ts";
import { exitCodes, releaseFor, type Live, type Release, type VersionInfo } from "./release.ts";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const release = releaseFor("v1.2.0", commitB);
const old: VersionInfo = { id: "old", tag: "v1.1.0", message: `ace v1.1.0 (${commitA})` };

/** A Worker on a pretend Cloudflare: deploys and rollbacks change what serves. */
class FakeWorker implements WorkerPort {
  current: Live;
  versions = new Map<string, VersionInfo>();
  migrated: string[] = [];
  migratedWhenDeployed: string[] | undefined;
  failMigration: string | undefined;
  failDeploy = false;
  /** The deploy activates the new version, then wrangler exits nonzero anyway. */
  failAfterActivating = false;
  failRollback = false;
  blindAfterDeploy = false;
  staleReads = 0;
  #next = 0;

  constructor(live: VersionInfo | Live | undefined) {
    if (live === undefined) this.current = { kind: "none" };
    else if ("kind" in live) this.current = live;
    else {
      this.versions.set(live.id, live);
      this.current = { kind: "single", version: live };
    }
  }

  #beforeDeploy: Live | undefined;
  async live() {
    if (this.blindAfterDeploy && this.#next > 0) throw new Error("API unavailable");
    if (this.#beforeDeploy && this.staleReads > 0) {
      this.staleReads -= 1;
      return this.#beforeDeploy;
    }
    return this.current;
  }
  async applyMigrations(binding: string) {
    if (binding === this.failMigration) throw new Error("D1 said no");
    this.migrated.push(binding);
  }
  async deploy(next: Release) {
    if (this.failDeploy) throw new Error("upload refused");
    this.#next += 1;
    const version = { id: `new-${this.#next}`, tag: next.tag, message: next.message };
    this.versions.set(version.id, version);
    this.migratedWhenDeployed = [...this.migrated];
    this.#beforeDeploy = this.current;
    this.current = { kind: "single", version };
    if (this.failAfterActivating) throw new Error("custom domain attach failed");
  }
  async rollback(versionId: string) {
    const version = this.versions.get(versionId);
    if (this.failRollback || !version) throw new Error("rollback refused");
    this.current = { kind: "single", version };
  }
  get liveId() {
    return this.current.kind === "single" ? this.current.version.id : this.current.kind;
  }
}

const input = (overrides: Partial<RunInput> = {}): RunInput => ({
  worker: "cloud",
  environment: "production",
  release,
  databases: [
    { binding: "ACCOUNTS", database_id: "9a611912-4571-46f4-9020-1b95ec8823fc" },
    { binding: "OTHER", database_id: "8ba0a218-1234-4dae-8ade-743a83549d7b" },
  ],
  origins: ["https://cloud.example", "https://relay.example"],
  migrationProblems: [],
  ...overrides,
});

/** Smoke passes while a version whose id is in `healthy` serves. */
function deps(worker: FakeWorker, healthy: Set<string>, extra: Partial<RunDeps> = {}): RunDeps {
  return {
    port: worker,
    smoke: async () => healthy.has(worker.liveId),
    sleep: async () => {},
    log: () => {},
    policy: { settleMs: 0, attempts: 2, betweenMs: 0 },
    ...extra,
  };
}

describe("a Worker release", () => {
  it("applies every migration, then sends the new version all traffic once it passes", async () => {
    const worker = new FakeWorker(old);
    const result = await runDeploy(input(), deps(worker, new Set(["old", "new-1"])));
    expect(result.code).toBe(exitCodes.deployed);
    expect(worker.liveId).toBe("new-1");
    expect(worker.migratedWhenDeployed).toEqual(["ACCOUNTS", "OTHER"]);
  });

  it("does nothing when this release already serves all traffic and passes", async () => {
    const worker = new FakeWorker({ id: "same", tag: release.tag, message: release.message });
    const result = await runDeploy(input(), deps(worker, new Set(["same"])));
    expect(result.code).toBe(exitCodes.deployed);
    expect(result.summary).toContain("nothing to do");
    expect(worker.liveId).toBe("same");
    expect(worker.migrated).toEqual([]);
  });

  it("asks for a human when this release already serves but fails its smoke", async () => {
    const worker = new FakeWorker({ id: "same", tag: release.tag, message: release.message });
    const result = await runDeploy(input(), deps(worker, new Set()));
    expect(result.code).toBe(exitCodes.needsHuman);
    expect(worker.liveId).toBe("same");
    expect(worker.migrated).toEqual([]);
  });

  it("deploys again when the tag matches but the commit doesn't", async () => {
    const worker = new FakeWorker({
      id: "retagged",
      tag: release.tag,
      message: `ace v1.2.0 (${commitA})`,
    });
    const result = await runDeploy(input(), deps(worker, new Set(["new-1"])));
    expect(result.code).toBe(exitCodes.deployed);
    expect(worker.liveId).toBe("new-1");
  });

  it("rolls back to the previous version when the new one fails its smoke", async () => {
    const worker = new FakeWorker(old);
    const result = await runDeploy(input(), deps(worker, new Set(["old"])));
    expect(result.code).toBe(exitCodes.rolledBack);
    expect(worker.liveId).toBe("old");
  });

  it("keeps a version that passes once the deploy has propagated", async () => {
    const worker = new FakeWorker(old);
    let calls = 0;
    const flaky = async () => (calls += 1) > 2;
    const result = await runDeploy(input(), deps(worker, new Set(), { smoke: flaky }));
    expect(result.code).toBe(exitCodes.deployed);
    expect(worker.liveId).toBe("new-1");
  });

  it("asks for a human when the previous version fails its smoke after the rollback", async () => {
    const worker = new FakeWorker(old);
    const result = await runDeploy(input(), deps(worker, new Set()));
    expect(result.code).toBe(exitCodes.needsHuman);
    expect(worker.liveId).toBe("old");
  });

  it("asks for a human when the rollback itself is refused", async () => {
    const worker = new FakeWorker(old);
    worker.failRollback = true;
    const result = await runDeploy(input(), deps(worker, new Set(["old"])));
    expect(result.code).toBe(exitCodes.needsHuman);
    expect(worker.liveId).toBe("new-1");
  });

  it("asks for a human when a first deploy fails, with nothing to go back to", async () => {
    const worker = new FakeWorker(undefined);
    const result = await runDeploy(input(), deps(worker, new Set()));
    expect(result.code).toBe(exitCodes.needsHuman);
  });

  it("still smokes, and rolls back, a release when Cloudflare can't say what serves", async () => {
    const worker = new FakeWorker(old);
    worker.blindAfterDeploy = true;
    const result = await runDeploy(input(), deps(worker, new Set(["old"])));
    expect(result.code).toBe(exitCodes.rolledBack);
    expect(worker.liveId).toBe("old");
  });

  it("waits out a lagging status read after a deploy that reported success", async () => {
    const worker = new FakeWorker(old);
    worker.staleReads = 1;
    const result = await runDeploy(input(), deps(worker, new Set(["new-1"])));
    expect(result.code).toBe(exitCodes.deployed);
    expect(worker.liveId).toBe("new-1");
  });

  it("never reports a deploy that reported success as unchanged", async () => {
    const worker = new FakeWorker(old);
    worker.staleReads = 5;
    const result = await runDeploy(input(), deps(worker, new Set(["old", "new-1"])));
    expect(result.code).toBe(exitCodes.rolledBack);
    expect(worker.liveId).toBe("old");
  });

  it("recovers a deploy that went live but failed, even when the first read lags", async () => {
    const worker = new FakeWorker(old);
    worker.failAfterActivating = true;
    worker.staleReads = 1;
    const result = await runDeploy(input(), deps(worker, new Set(["old"])));
    expect(result.code).toBe(exitCodes.rolledBack);
    expect(worker.liveId).toBe("old");
  });

  it("keeps a deploy that went live, failed, and still passes its smoke", async () => {
    const worker = new FakeWorker(old);
    worker.failAfterActivating = true;
    worker.staleReads = 1;
    const result = await runDeploy(input(), deps(worker, new Set(["old", "new-1"])));
    expect(result.code).toBe(exitCodes.deployed);
    expect(worker.liveId).toBe("new-1");
  });

  it("smokes what serves after a failed deploy instead of trusting it unchanged", async () => {
    const worker = new FakeWorker(old);
    worker.failDeploy = true;
    const result = await runDeploy(input(), deps(worker, new Set()));
    expect(result.code).toBe(exitCodes.needsHuman);
    expect(worker.liveId).toBe("old");
  });

  it("reports a first deploy that never took as unchanged, with nothing to recover", async () => {
    const worker = new FakeWorker(undefined);
    worker.failDeploy = true;
    const result = await runDeploy(input(), deps(worker, new Set()));
    expect(result.code).toBe(exitCodes.unchanged);
    expect(worker.liveId).toBe("none");
  });

  it("refuses to deploy over split traffic, leaving it as it is", async () => {
    const split: Live = { kind: "split", versionIds: ["x", "y"] };
    const worker = new FakeWorker(split);
    const result = await runDeploy(input(), deps(worker, new Set(["new-1"])));
    expect(result.code).toBe(exitCodes.unchanged);
    expect(worker.current).toBe(split);
    expect(worker.migrated).toEqual([]);
  });

  it("stops before deploying when a migration fails", async () => {
    const worker = new FakeWorker(old);
    worker.failMigration = "OTHER";
    const result = await runDeploy(input(), deps(worker, new Set(["old", "new-1"])));
    expect(result.code).toBe(exitCodes.unchanged);
    expect(worker.liveId).toBe("old");
  });

  it("reports the release unchanged when the deploy never took", async () => {
    const worker = new FakeWorker(old);
    worker.failDeploy = true;
    const result = await runDeploy(input(), deps(worker, new Set(["old"])));
    expect(result.code).toBe(exitCodes.unchanged);
    expect(result.summary).toContain("upload refused");
    expect(worker.liveId).toBe("old");
  });

  it("refuses migrations the lint rejects before touching anything", async () => {
    const worker = new FakeWorker(old);
    const problems = ["0004.sql:1: [drop-table] drops a table"];
    const result = await runDeploy(input({ migrationProblems: problems }), deps(worker, new Set()));
    expect(result.code).toBe(exitCodes.unchanged);
    expect(worker.migrated).toEqual([]);
  });

  it("refuses an environment whose database ids are still placeholders", async () => {
    const worker = new FakeWorker(old);
    const databases = [
      { binding: "ACCOUNTS", database_id: "REPLACE-WITH-ace-accounts-staging-ID" },
    ];
    const result = await runDeploy(input({ databases }), deps(worker, new Set(["new-1"])));
    expect(result.code).toBe(exitCodes.unchanged);
    expect(worker.liveId).toBe("old");
  });

  it("holds production until staging runs the same release", async () => {
    const worker = new FakeWorker(old);
    const staging = new FakeWorker(old);
    const waiting = await runDeploy(input(), deps(worker, new Set(["new-1"]), { staging }));
    expect(waiting.code).toBe(exitCodes.unchanged);
    expect(worker.liveId).toBe("old");

    await staging.deploy(release);
    const going = await runDeploy(input(), deps(worker, new Set(["new-1"]), { staging }));
    expect(going.code).toBe(exitCodes.deployed);
    expect(worker.liveId).toBe("new-1");
  });
});
