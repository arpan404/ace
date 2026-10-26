import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type { Frame, SessionContext } from "@ace/engine-api";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { piNative } from "@ace/provider-kit/access-modes";
import { sessionHarness } from "./testing/harness.ts";
import { ended, stubbornTree, writeCmdShim } from "@ace/provider-kit/testing/cmd-shim";
import { obj, str } from "./native.ts";

// npm installs Pi on Windows as `pi.cmd`, so every case launches the fake through cmd.exe.
// Windows has no SIGTERM for it: close ends Pi's stdin, then stops the tree.
const windows = process.platform === "win32";
const fakePi = fileURLToPath(new URL("./testing/fake-pi.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporary(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
/** The harness's fake Pi, launched through a `.cmd` shim with the arguments ace built. */
async function shimmed(
  options: {
    resume?: boolean;
    env?: NodeJS.ProcessEnv;
    permissionMode?: SessionContext["permissionMode"];
    builtinSkills?: SessionContext["builtinSkills"];
    preload?: (dir: string) => Promise<string>;
  } = {},
) {
  const dir = await temporary("ace-pi-shim-");
  const shim = await writeCmdShim(dir, "pi", fakePi, await options.preload?.(dir));
  const frames: Frame[] = [];
  const h = await sessionHarness(
    {
      runtime: {
        spawn: (spawnOptions) => spawnTextSupervised({ ...spawnOptions, command: shim }),
      },
    },
    options.resume ?? false,
    options.env ?? {},
    undefined,
    options.permissionMode,
    frames,
    options.builtinSkills,
  );
  return { ...h, dir };
}
/** Records the arguments the shim forwarded, as the launched process received them. */
async function argvRecorder(dir: string) {
  const path = join(dir, "argv.mjs");
  await writeFile(
    path,
    'import { writeFileSync } from "node:fs";\n' +
      "writeFileSync(process.env.ACE_TEST_ARGV, JSON.stringify(process.argv.slice(2)));\n",
  );
  return path;
}
const received = (type: string, id?: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "recv" && obj(f.data).type === type && (id === undefined || obj(f.data).id === id);
const text = (value: string) => [{ type: "text" as const, text: value }];

test.runIf(windows)(
  "Windows Pi behind a .cmd shim resumes its saved session before any prompt, then streams steering and follow-up",
  async () => {
    const h = await shimmed({ resume: true });
    try {
      expect(h.session.nativeSessionFile).toBe(h.resumedPath);
      expect(h.frames.filter((f) => f.dir === "send" && obj(f.data).type === "prompt")).toEqual([]);
      await h.session.send(text("hello"), "steer");
      await h.wait(received("extension_ui_request", "input-proof"));
      await h.session.send(text("again"), "queue");
      expect(
        h.frames
          .filter((f) => f.dir === "send" && obj(f.data).type === "prompt")
          .map((f) => obj(f.data).streamingBehavior),
      ).toEqual(["steer", "followUp"]);
      expect(
        Object.values(h.h.state.items)
          .filter((item) => item.type === "message" && item.role === "assistant")
          .map((item) => (item.type === "message" ? item.parts : [])),
      ).toEqual([
        [{ type: "text", text: "hello world !" }],
        [{ type: "text", text: "hello world !" }],
      ]);
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windows)(
  "Windows Pi receives its access mode, extension and skill paths with spaces and & intact through cmd.exe",
  async () => {
    const skills = await temporary("ace-pi-skills-");
    const root = join(skills, "ace skills & more");
    await mkdir(join(root, "ace-browser"), { recursive: true });
    await writeFile(
      join(root, "ace-browser", "SKILL.md"),
      "---\nname: ace-browser\ndescription: Use for ace-browser.\n---\n\nBody.\n",
    );
    const argv = join(skills, "argv.json");
    const h = await shimmed({
      env: { ACE_TEST_ARGV: argv },
      permissionMode: piNative.readOnly,
      builtinSkills: { args: [], directories: [root] },
      preload: argvRecorder,
    });
    try {
      const args: unknown = JSON.parse(await readFile(argv, "utf8"));
      expect(args).toEqual([
        "--mode",
        "rpc",
        "-e",
        fileURLToPath(new URL("./extension.ts", import.meta.url)),
        "--tools",
        expect.stringContaining("read,grep,find,ls"),
        "--skill",
        root,
      ]);
      await h.session.send(text("skills-proof"), "queue");
      const listed = await h.wait(
        (frame) => frame.dir === "recv" && JSON.stringify(frame.data).includes("ace-browser"),
      );
      expect(JSON.stringify(listed.data)).toContain("ace-browser");
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windows)(
  "Windows Pi answers a confirmation over RPC and interrupts by native abort",
  async () => {
    const h = await shimmed();
    try {
      await h.session.send(text("dialogs"), "queue");
      await h.wait(received("extension_ui_request", "confirm"));
      expect(h.h.state.interactions.confirm?.request.kind).toBe("question");
      await h.session.resolve("confirm", { kind: "question", answers: { confirm: ["no"] } });
      const proof = await h.wait(received("extension_ui_request", "answer-proof"));
      expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
        id: "confirm",
        confirmed: false,
      });
    } finally {
      await h.dispose();
    }
    const fresh = await shimmed();
    try {
      await fresh.session.send(text("queued"), "steer");
      await fresh.session.interrupt({ cascade: true });
      const aborted = await fresh.wait(received("extension_ui_request", "abort-proof"));
      expect(obj(aborted.data).message).toBe("queue cleared");
      expect(fresh.h.state.status.state).toBe("done");
    } finally {
      await fresh.dispose();
    }
  },
);

test.runIf(windows)(
  "Windows Pi close ends a Pi that ignores EOF and polite stops, with its grandchild",
  async () => {
    const pids = join(await temporary("ace-pi-tree-"), "pids.json");
    const h = await shimmed({ env: { ACE_TEST_TREE_PIDS: pids }, preload: stubbornTree });
    const tree = obj(JSON.parse(await readFile(pids, "utf8")));
    await h.dispose();
    expect(await ended(Number(tree.agent))).toBe(true);
    expect(await ended(Number(tree.child))).toBe(true);
  },
);
