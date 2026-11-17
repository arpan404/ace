import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { commandTable } from "./commands/table.ts";
import { daemonRefs } from "./completion-daemon.ts";
import { completeLive, type RefReader, type RefSource } from "./completion-live.ts";
import { candidateLines, complete } from "./completion.ts";

const table = commandTable();

/** A daemon holding these references, answering at once. */
function holding(refs: {
  threads?: { id: string; title: string }[];
  projects?: { id: string; name: string; path: string }[];
  requests?: { id: string; kind: string; threadTitle: string }[];
  bots?: { id: string; name: string; task?: string }[];
}): RefReader {
  return {
    threads: async () => refs.threads ?? [],
    projects: async () => refs.projects ?? [],
    requests: async () => refs.requests ?? [],
    bots: async () => refs.bots ?? [],
  };
}

/** A daemon that is up and reads with `reader`. */
function up(reader: RefReader): RefSource {
  return { reach: async () => reader };
}

const daemon = up(
  holding({
    threads: [
      { id: "t_9f2c41", title: "Fix the login page" },
      { id: "t_a01b22", title: "Add retry tests" },
    ],
    projects: [
      { id: "w_1", name: "ace", path: "/src/ace" },
      { id: "w_2", name: "My Notes", path: "/src/notes" },
    ],
    requests: [{ id: "i_77aa01", kind: "approval", threadTitle: "Fix the login page" }],
    bots: [
      { id: "b_1", name: "spade", task: "Spade's main bot" },
      { id: "b_2", name: "release-watch" },
    ],
  }),
);

describe("live references", () => {
  test("a thread argument offers the daemon's thread ids with their titles", async () => {
    expect(await completeLive(table, ["thread", "show", ":t_9"], daemon, 1_000)).toEqual([
      { value: "t_9f2c41", description: "Fix the login page" },
    ]);
  });

  test("a --thread value offers threads too", async () => {
    const values = await completeLive(table, ["request", "answer", "--thread", ":"], daemon, 1_000);
    expect(values.map((candidate) => candidate.value)).toEqual(["t_9f2c41", "t_a01b22"]);
  });

  test("a project slot offers names, and the id for a name a shell would split", async () => {
    expect(await completeLive(table, ["thread", "list", "--project", ":"], daemon, 1_000)).toEqual([
      { value: "ace", description: "/src/ace" },
      { value: "w_2", description: "My Notes · /src/notes" },
    ]);
    expect(await completeLive(table, ["project", "remove", ":a"], daemon, 1_000)).toEqual([
      { value: "ace", description: "/src/ace" },
    ]);
  });

  test("a request argument offers open request ids with what they ask", async () => {
    expect(await completeLive(table, ["request", "answer", ":"], daemon, 1_000)).toEqual([
      { value: "i_77aa01", description: "approval in Fix the login page" },
    ]);
  });

  test("a bot argument offers Spade's bot names", async () => {
    expect(await completeLive(table, ["spade", "chat", ":"], daemon, 1_000)).toEqual([
      { value: "spade", description: "Spade's main bot" },
      { value: "release-watch" },
    ]);
  });

  test("a word that names no reference offers only what the table knows", async () => {
    const verbs = await completeLive(table, ["thread", ":s"], daemon, 1_000);
    expect(verbs.map((candidate) => candidate.value)).toEqual(complete(table, ["thread", ":s"]));
    // TEXT after the thread is free text: nothing to offer.
    expect(await completeLive(table, ["thread", "send", "t_9f2c41", ":"], daemon, 1_000)).toEqual(
      [],
    );
  });

  test("a line aimed at a remote gets nothing from this machine's daemon", async () => {
    expect(
      await completeLive(table, ["--remote", "box", "thread", "show", ":"], daemon, 1_000),
    ).toEqual([]);
  });

  test("a value flag's word is skipped when finding the argument being typed", async () => {
    const values = await completeLive(
      table,
      ["thread", "show", "--items", "50", ":t_a"],
      daemon,
      1_000,
    );
    expect(values.map((candidate) => candidate.value)).toEqual(["t_a01b22"]);
  });
});

describe("the daemon's budget", () => {
  test("a daemon that never answers leaves the table's candidates once the budget runs out", async () => {
    let abandoned = false;
    const silent = up({
      ...holding({}),
      threads: (signal) =>
        new Promise(() => signal.addEventListener("abort", () => (abandoned = true))),
    });
    const started = performance.now();
    const values = await completeLive(table, ["thread", "show", ":"], silent, 20);
    expect(values).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(abandoned).toBe(true);
  });

  test("a flag's own choices come from the table", async () => {
    const colors = await completeLive(table, ["thread", "show", "--color", ":a"], daemon, 1_000);
    expect(colors).toEqual([{ value: "auto" }, { value: "always" }]);
  });

  test("a daemon that fails leaves the table's candidates", async () => {
    const failing = up({
      ...holding({ threads: [{ id: "t_1", title: "One" }] }),
      projects: async () => {
        throw new Error("forbidden");
      },
    });
    expect(await completeLive(table, ["thread", "list", "--project", ":"], failing, 1_000)).toEqual(
      [],
    );
  });
});

describe("with ace down", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  async function home() {
    const root = await mkdtemp(join(tmpdir(), "ace-completion-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    return root;
  }

  test("no daemon in the home: the table alone, and nothing is written", async () => {
    const root = await home();
    const values = await completeLive(
      table,
      ["thread", "show", ":"],
      daemonRefs(() => root),
      300,
    );
    expect(values).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  test("a stopped daemon's endpoint: the table alone, at once, and nothing is written", async () => {
    const root = await home();
    const port = await closedPort();
    await writeFile(join(root, "daemon-endpoint"), `http://127.0.0.1:${port}/`);
    await writeFile(join(root, "daemon-token"), "a".repeat(64));
    const started = performance.now();
    const values = await completeLive(
      table,
      ["thread", "list", "--project", ":"],
      daemonRefs(() => root),
      5_000,
    );
    expect(values).toEqual([]);
    // Refused at once, not waited out.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect((await readdir(root)).toSorted()).toEqual(["daemon-endpoint", "daemon-token"]);
  });
});

describe("what ace __complete prints", () => {
  test("a value, then its description after a tab, one per line", () => {
    expect(
      candidateLines([
        { value: "t_9f2c41", description: "Fix the\tlogin\npage" },
        { value: "thread" },
        { value: "two\twords" },
        { value: "thread", description: "again" },
      ]),
    ).toBe("t_9f2c41\tFix the login page\nthread\n");
  });

  test("a long description is cut to one short line", () => {
    const [line] = candidateLines([{ value: "t_1", description: "x".repeat(200) }]).split("\n");
    expect(line?.length).toBeLessThanOrEqual(84);
    expect(line?.endsWith("…")).toBe(true);
  });
});

/** A local port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}
