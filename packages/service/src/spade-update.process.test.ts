import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { checked, runProcess, type Runner } from "./process.ts";
import { spadeServicePlan } from "./spade-plan.ts";
import { installSpadeBinary, installedSpadeVersion } from "./spade-release.ts";
import { installSpadeService } from "./spade-service.ts";
import { updateSpade } from "./spade-update.ts";

/**
 * The real edges of Spade's swap: its HTTP API, a SQLite backup of its database, and the new
 * binary run with `--check-migrations`. Only launchd is faked, and it behaves like launchd with
 * real Spade: starting runs the binary `current` names, which reports the version stamped into
 * it (`--version`), writes a fresh token, pid and port, answers `/health?nonce` with the proof,
 * and migrates the database to its own schema; `kickstart` replaces the process.
 */
const posix = process.platform !== "win32";

test.runIf(posix)(
  "an update pauses Spade, checks a copy of its database with the new binary, then restarts it",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, { candidate: spadeBinary("0.5.0") });
    const result = await world.update("now");
    expect(result).toEqual({ kind: "swapped", from: "0.4.0", to: "0.5.0" });
    expect(world.requests).toEqual(['POST /v1/maintenance {"mode":"now","deadline_ms":30000}']);
    expect(await installedSpadeVersion(world.home)).toBe("0.5.0");
    expect(world.spade()).toMatchObject({ version: "0.5.0", pid: 2 });
    // The check ran on a copy, which is gone again, as is the rollback snapshot.
    expect(await readFile(world.checkedPath, "utf8")).toMatch(
      /spade-migration-check\/spade\.sqlite$/,
    );
    expect(existsSync(join(world.home, ".spade-migration-check"))).toBe(false);
    expect(existsSync(join(world.home, ".spade-update-snapshot"))).toBe(false);
  },
);

test.runIf(posix)(
  "a new binary that refuses the database leaves the old Spade running with admission reopened",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, {
      candidate: spadeBinary("0.5.0", "echo 'schema 12 is newer than 0.5.0' >&2; exit 1"),
    });
    const result = await world.update("idle");
    expect(result).toMatchObject({ kind: "failed", from: "0.4.0", to: "0.5.0" });
    expect(result.kind === "failed" && result.error).toMatch(/schema 12 is newer/);
    expect(world.requests.at(-1)).toBe("DELETE /v1/maintenance");
    expect(await installedSpadeVersion(world.home)).toBe("0.4.0");
    expect(world.spade()).toMatchObject({ version: "0.4.0", pid: 1 });
  },
);

test.runIf(posix)(
  "a binary that reports another version than the release's is rolled back",
  async ({ onTestFinished }) => {
    // An unstamped build reports Spade's own Cargo version.
    const world = await setup(onTestFinished, { candidate: spadeBinary("0.1.0") });
    const result = await world.update("now");
    expect(result.kind === "failed" && result.error).toMatch(/0.4.0 is running again/);
    expect(await installedSpadeVersion(world.home)).toBe("0.4.0");
    expect(world.spade()).toMatchObject({ version: "0.4.0" });
  },
);

test.runIf(posix)(
  "a new Spade that migrated the database and then failed hands the old one its database back",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, {
      candidate: spadeBinary("0.5.0"),
      crashes: "0.5.0",
    });
    const result = await world.update("now");
    expect(result.kind === "failed" && result.error).toMatch(/0.4.0 is running again/);
    expect(world.schema()).toBe(4);
    expect(world.spade()).toMatchObject({ version: "0.4.0" });
    // The failed version's database is set aside, never deleted, and the result says where.
    const aside = `${world.database}.failed-0.5.0`;
    expect(result.kind === "failed" && result.error).toContain(`set aside in ${aside}`);
    expect(world.turns(aside)).toEqual(["t1", "stored during the swap by 0.4.0"]);
    expect(world.turns()).toEqual(["t1"]);
  },
);

test.runIf(posix)(
  "a new Spade that failed before touching the database leaves what the swap stored in place",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, {
      candidate: spadeBinary("0.5.0"),
      diesEarly: "0.5.0",
    });
    const result = await world.update("now");
    expect(result.kind === "failed" && result.error).toMatch(/0.4.0 is running again$/);
    expect(world.turns()).toEqual(["t1", "stored during the swap by 0.4.0"]);
    expect(existsSync(`${world.database}.failed-0.5.0`)).toBe(false);
  },
);

test.runIf(posix)(
  "a first start that takes a while to migrate isn't rolled back",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, {
      candidate: spadeBinary("0.5.0"),
      slowStart: 75_000,
    });
    expect(await world.update("now")).toMatchObject({ kind: "swapped", to: "0.5.0" });
    expect(world.spade()).toMatchObject({ version: "0.5.0" });
  },
);

test.runIf(posix)(
  "a new Spade whose process exited is given up on quickly",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, {
      candidate: spadeBinary("0.5.0"),
      diesEarly: "0.5.0",
    });
    await world.update("now");
    // The exited process's short limit, not the minutes a running start gets.
    expect(world.elapsed()).toBeLessThan(20_000);
  },
);

test.runIf(posix)(
  "something else answering at Spade's port without the proof isn't taken for the new Spade",
  async ({ onTestFinished }) => {
    const world = await setup(onTestFinished, { candidate: spadeBinary("0.5.0"), impostor: true });
    const result = await world.update("now");
    expect(result).toMatchObject({ kind: "failed", from: "0.4.0" });
    expect(world.spade()).toMatchObject({ version: "0.4.0" });
  },
);

test.runIf(posix)(
  "a restart that left the old process running isn't counted as the new Spade",
  async ({ onTestFinished }) => {
    // The running process already reports the release's version; only its pid gives it away.
    const world = await setup(onTestFinished, {
      installed: spadeBinary("0.5.0"),
      candidate: spadeBinary("0.5.0"),
      ignoresKickstart: true,
    });
    const result = await world.update("now");
    expect(result.kind).toBe("failed");
  },
);

/** The schema a version migrates Spade's database to: its minor number here. */
const schemaOf = (version: string) => Number(version.split(".")[1]);

/** A stand-in `spade-server`: `--version` prints its stamped version, `--check-migrations` runs `check`. */
function spadeBinary(version: string, check = "exit 0") {
  return { version, check };
}

async function setup(
  onTestFinished: (fn: () => Promise<void>) => void,
  options: {
    installed?: ReturnType<typeof spadeBinary>;
    candidate: ReturnType<typeof spadeBinary>;
    /** A version whose process migrates the database on start and then exits. */
    crashes?: string;
    /** A version that exits on start before it touches the database. */
    diesEarly?: string;
    /** How long (ms, on the test's clock) the new version takes to migrate and come up. */
    slowStart?: number;
    /** After a restart, a process without Spade's token answers at the new address. */
    impostor?: boolean;
    ignoresKickstart?: boolean;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "ace-spade-update-"));
  const servers = new Set<Server>();
  const close = async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    servers.clear();
  };
  onTestFinished(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, ".ace");
  const data = join(home, "spade");
  await mkdir(data, { recursive: true });
  const database = join(data, "spade.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE turns (id TEXT); INSERT INTO turns VALUES ('t1'); PRAGMA user_version = 4");
  db.close();
  const checkedPath = join(root, "checked-path");
  const write = async (name: string, binary: ReturnType<typeof spadeBinary>) => {
    const path = join(root, name);
    await writeFile(
      path,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo ${binary.version}; exit 0; fi\nprintf '%s' "$2" > '${checkedPath}'\n${binary.check}\n`,
      { mode: 0o755 },
    );
    return path;
  };
  await installSpadeBinary(
    home,
    await write("old-spade", options.installed ?? spadeBinary("0.4.0")),
    "0.4.0",
  );
  const candidate = await write("new-spade", options.candidate);

  const requests: string[] = [];
  let running: { version: string; pid: number } | undefined;
  let pids = 0;
  let admission = "open";
  let clock = 0;
  /** A start launchd made that hasn't finished yet: Spade migrating before server.json. */
  let starting: { at: number } | undefined;
  const conversation = (text: string) => {
    const write = new DatabaseSync(database);
    write.prepare("INSERT INTO turns VALUES (?)").run(text);
    write.close();
  };
  /** What launchd's start does: run `current`'s binary as Spade. */
  const start = async () => {
    await close();
    running = undefined;
    const binary = join(home, "releases/spade/current/spade-server");
    const version = (await checked(runProcess, binary, ["--version"])).stdout.trim();
    if (options.diesEarly === version) return;
    const read = new DatabaseSync(database);
    const schema = Number(read.prepare("PRAGMA user_version").get()?.user_version);
    // Real Spade refuses a database newer than it knows, and migrates an older one.
    if (schema > schemaOf(version)) return read.close();
    read.exec(`PRAGMA user_version = ${schemaOf(version)}`);
    read.close();
    if (options.crashes === version) return;
    const token = randomBytes(32).toString("hex");
    const pid = ++pids;
    // The new version never comes up; another process holds the address it was given.
    const impostor = options.impostor && version === options.candidate.version;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://spade");
        if (url.pathname === "/health") {
          const nonce = url.searchParams.get("nonce");
          const proof =
            nonce && !impostor
              ? createHmac("sha256", token).update(nonce).digest("hex")
              : undefined;
          response.end(JSON.stringify({ ok: true, version, api: 1, ...(proof ? { proof } : {}) }));
          return;
        }
        if (impostor || request.headers.authorization !== `Bearer ${token}`) {
          response.statusCode = 401;
          response.end();
          return;
        }
        if (request.method !== "GET")
          requests.push(`${request.method} ${url.pathname}${body ? ` ${body}` : ""}`);
        if (request.method === "POST") admission = "closed";
        if (request.method === "DELETE") admission = "open";
        response.end(JSON.stringify({ admission, running_turns: 0, running_jobs: 0 }));
      });
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    admission = "open";
    await writeFile(join(data, "token"), token);
    await writeFile(
      join(data, "server.json"),
      JSON.stringify({ address: `127.0.0.1:${port}`, pid, version, api: 1 }),
    );
    if (!impostor) running = { version, pid };
  };

  const plan = spadeServicePlan(home, "darwin", { userHome: root, uid: 501 });
  let loaded = false;
  const run: Runner = async (file, args) => {
    if (file !== "launchctl") return runProcess(file, args);
    if (args[0] === "print")
      return loaded
        ? {
            code: 0,
            stderr: "",
            stdout: `\tpath = ${plan.file}\n\tstate = ${running || starting ? "running" : "waiting"}\n\tprogram = ${plan.command[0]}\n\targuments = {\n\t\t${plan.command[0]}\n\t}\n`,
          }
        : { code: 113, stderr: "", stdout: "" };
    if (args[0] === "bootstrap") {
      loaded = true;
      await start();
    }
    if (args[0] === "bootout") {
      loaded = false;
      running = undefined;
      await close();
    }
    if (args[0] === "kickstart") {
      if (!loaded) return { code: 113, stderr: "", stdout: "" };
      if (options.ignoresKickstart) return { code: 0, stderr: "", stdout: "" };
      // The old Spade stores one last message as it goes down, after the snapshot was taken.
      if (running) conversation(`stored during the swap by ${running.version}`);
      const slow = options.slowStart ?? 0;
      if (slow > 0 && running?.version !== options.candidate.version) {
        await close();
        running = undefined;
        starting = { at: clock + slow };
      } else await start();
    }
    return { code: 0, stderr: "", stdout: "" };
  };
  const service = {
    run,
    async wait(ms: number) {
      clock += ms;
      if (starting && clock >= starting.at) {
        starting = undefined;
        await start();
      }
    },
  };
  await installSpadeService(plan, service);
  const schema = () => {
    const read = new DatabaseSync(database, { readOnly: true });
    try {
      return Number(read.prepare("PRAGMA user_version").get()?.user_version);
    } finally {
      read.close();
    }
  };
  return {
    home,
    requests,
    checkedPath,
    schema,
    spade: () => running,
    update: (mode: "idle" | "now") =>
      updateSpade({
        home,
        source: candidate,
        version: "0.5.0",
        mode,
        plan,
        io: { service, now: () => clock },
      }),
    /** The test's clock: advanced only by the updater's waits. */
    elapsed: () => clock,
    turns: (file = database) => {
      const read = new DatabaseSync(file, { readOnly: true });
      try {
        return read
          .prepare("SELECT id FROM turns")
          .all()
          .map((row) => String(row.id));
      } finally {
        read.close();
      }
    },
    database,
  };
}
