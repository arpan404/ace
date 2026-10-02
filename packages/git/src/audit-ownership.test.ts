import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { execute, git, put, repository, scratch } from "./test-repo.ts";

const service = new GitService();

test.each(["compatible", "incompatible"])(
  "HEAD-seeded ignored children retain checkout ownership and locks with a %s parent filter",
  async (parentFilter) => {
    const repo = await repository({
      "child/.gitattributes": "*.txt filter=case\n",
      "child/a.txt": "target a\n",
      "child/z.txt": "target z\n",
    });
    const child = join(repo, "child");
    await git(child, "init", "-b", "main");
    await git(child, "config", "filter.case.clean", "tr a-z A-Z");
    await git(child, "config", "filter.case.smudge", "tr A-Z a-z");
    await git(child, "add", "--all");
    const target = await service.createCheckpoint({
      worktree: repo,
      threadId: "ownership",
      label: "target",
    });
    await git(repo, "rm", "--cached", "-r", "child");
    await put(repo, ".gitignore", "child/\n");
    await put(child, "a.txt", "after a\n");
    await put(child, "z.txt", "after z\n");
    await git(
      repo,
      "config",
      "filter.case.smudge",
      parentFilter === "incompatible" ? "false" : "cat",
    );
    await git(repo, "config", "filter.case.required", "true");
    const indexes = await Promise.all(
      [repo, child].map((root) => readFile(join(root, ".git", "index"))),
    );
    const directory = await scratch();
    const release = join(directory, "release");
    const filter = join(directory, "smudge.mjs");
    await writeFile(
      filter,
      `
      import fs from 'node:fs';
      const contents = fs.readFileSync(0, 'utf8');
      if (process.argv[2] === 'z.txt') {
        await new Promise(resolve => {
          const watcher = fs.watch(${JSON.stringify(directory)}, (_event, name) => {
            if (name === 'release') { watcher.close(); resolve(); }
          });
          process.stderr.write('ACE_CHECKOUT_READY\\n');
        });
      }
      process.stdout.write(contents.toLowerCase());
    `,
    );
    await git(
      child,
      "config",
      "filter.case.smudge",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)} %f`,
    );
    const entry = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
    // The real child smudge filter pauses checkout after a.txt, before z.txt.
    // Unreferencing just that process's handles permits a positive event-loop
    // idle barrier after the competing checkpoint's real Git I/O has drained.
    // The barrier re-references them before releasing the filter.
    const script = `
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      const { GitService } = await import(${JSON.stringify(entry)});
      const ready = Promise.withResolvers();
      const running = new Set();
      let checkout;
      let marker = '';
      const processRuntime = {
        scheduleTimeout: () => () => {},
        spawn: (command, args, options) => {
          const child = spawn(command, args, options);
          running.add(child);
          child.once('close', () => running.delete(child));
          if (options.cwd === ${JSON.stringify(child)} && args.includes('read-tree') && args.includes('--reset')) {
            checkout = child;
            child.stderr.on('data', bytes => {
              marker += bytes.toString();
              if (marker.includes('ACE_CHECKOUT_READY\\n')) ready.resolve();
            });
          }
          return child;
        }
      };
      process.on('exit', () => {
        for (const child of running) if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      });
      const restore = new GitService({processRuntime}).restoreCheckpoint({worktree:${JSON.stringify(repo)},checkpoint:${JSON.stringify(target.id)}});
      try {
        await Promise.race([ready.promise, restore.then(() => { throw new Error('restore completed before child checkout barrier'); })]);
        let checkpointSettled = false;
        const checkpoint = new GitService().createCheckpoint({worktree:${JSON.stringify(child)},threadId:'during-checkout',label:'during checkout'});
        checkpoint.then(() => { checkpointSettled = true; }, () => { checkpointSettled = true; });
        const idle = Promise.withResolvers();
        process.once('beforeExit', () => {
          checkout.ref();
          for (const pipe of [checkout.stdin, checkout.stdout, checkout.stderr]) pipe.ref();
          fs.writeFileSync(${JSON.stringify(release)}, 'release');
          idle.resolve(checkpointSettled);
        });
        checkout.unref();
        for (const pipe of [checkout.stdin, checkout.stdout, checkout.stderr]) pipe.unref();
        const settledDuringCheckout = await idle.promise;
        await restore;
        const saved = await checkpoint;
        process.stdout.write(JSON.stringify({settledDuringCheckout,checkpointId:saved.id}));
      } finally {
        if (checkout) {
          checkout.ref();
          for (const pipe of [checkout.stdin, checkout.stdout, checkout.stderr]) pipe.ref();
        }
        fs.writeFileSync(${JSON.stringify(release)}, 'release');
        await restore.catch(() => {});
      }
    `;
    let stdout: string;
    try {
      ({ stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script], {
        timeout: PROCESS_TEST_TIMEOUT,
      }));
    } finally {
      await writeFile(release, "release");
    }
    const checkpoints = await service.listCheckpoints({ repo: child, threadId: "during-checkout" });
    expect(checkpoints).toHaveLength(1);
    const checkpoint = checkpoints[0];
    if (!checkpoint) throw new Error("Missing child checkpoint");
    expect(JSON.parse(stdout)).toEqual({
      settledDuringCheckout: false,
      checkpointId: checkpoint.id,
    });
    expect((await git(child, "show", `${checkpoint.sha}:a.txt`)).toString()).toBe("TARGET A\n");
    expect((await git(child, "show", `${checkpoint.sha}:z.txt`)).toString()).toBe("TARGET Z\n");
    expect(await readFile(join(child, "a.txt"), "utf8")).toBe("target a\n");
    expect(await readFile(join(child, "z.txt"), "utf8")).toBe("target z\n");
    expect(
      await Promise.all([repo, child].map((root) => readFile(join(root, ".git", "index")))),
    ).toEqual(indexes);
    const safety = (await service.listCheckpoints({ repo, threadId: "ownership" })).find(
      (saved) => saved.label === `Before restore of ${target.id}`,
    );
    if (!safety) throw new Error("Missing safety checkpoint");
    expect((await git(repo, "show", `${safety.sha}:child/a.txt`)).toString()).toBe("AFTER A\n");
    expect((await git(repo, "show", `${safety.sha}:child/z.txt`)).toString()).toBe("AFTER Z\n");
  },
);

test("unchanged HEAD-tracked ignored children still use their own clean filters after staged parent deletion", async () => {
  const repo = await repository({
    "child/.gitattributes": "file.txt filter=case\n",
    "child/file.txt": "working contents\n",
  });
  const child = join(repo, "child");
  await git(child, "init", "-b", "main");
  await git(child, "config", "filter.case.clean", "tr a-z A-Z");
  await git(child, "add", "--all");
  await git(repo, "rm", "--cached", "-r", "child");
  await put(repo, ".gitignore", "child/\n");
  const indexes = await Promise.all(
    [repo, child].map((root) => readFile(join(root, ".git", "index"))),
  );
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "hidden-unchanged",
    label: "unchanged child",
  });
  expect((await git(repo, "show", `${saved.sha}:child/file.txt`)).toString()).toBe(
    "WORKING CONTENTS\n",
  );
  expect(
    await Promise.all([repo, child].map((root) => readFile(join(root, ".git", "index")))),
  ).toEqual(indexes);
});

test("ignored files in HEAD-seeded children refuse restore and retain safety and both indexes", async () => {
  const repo = await repository({ "child/file.txt": "target\n" });
  const child = join(repo, "child");
  await git(child, "init", "-b", "main");
  await git(child, "add", "--all");
  const target = await service.createCheckpoint({
    worktree: repo,
    threadId: "hidden-collision",
    label: "target",
  });
  await git(repo, "rm", "--cached", "-r", "child");
  await put(repo, ".gitignore", "child/\n");
  await git(child, "rm", "--cached", "file.txt");
  await put(child, ".gitignore", "file.txt\n");
  await put(child, "file.txt", "private ignored contents\n");
  const indexes = await Promise.all(
    [repo, child].map((root) => readFile(join(root, ".git", "index"))),
  );
  await expect(
    service.restoreCheckpoint({ worktree: repo, checkpoint: target.id }),
  ).rejects.toMatchObject({
    code: "restore_collision",
    details: { safetyCheckpointId: expect.any(String) },
  });
  expect(await readFile(join(child, "file.txt"), "utf8")).toBe("private ignored contents\n");
  expect(
    await Promise.all([repo, child].map((root) => readFile(join(root, ".git", "index")))),
  ).toEqual(indexes);
  expect(
    (await service.listCheckpoints({ repo, threadId: "hidden-collision" })).map(
      (saved) => saved.label,
    ),
  ).toEqual(["target", `Before restore of ${target.id}`]);
});
