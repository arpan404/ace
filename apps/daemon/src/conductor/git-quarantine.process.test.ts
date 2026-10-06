import { afterEach, expect, test } from "vitest";
import { GitService, spawnGitProcess } from "@ace/git";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";

afterEach(closeDeckFixtures);

test("Deck exposes uncertain Git cleanup and keeps its integration intent after daemon restart", async () => {
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const deadlines = new Set<() => void>();
  let intercept = true;
  const h = await deckFixture({
    git: {
      processRuntime: {
        spawn: (binary, args, options) => {
          if (!intercept || !args.includes("worktree") || !args.includes("add"))
            return spawnGitProcess(binary, args, options);
          intercept = false;
          // An exclusive fixture executable, never an installed provider CLI.
          const child = spawnGitProcess(
            process.execPath,
            ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
            options,
          );
          child.stdout.once("data", () => ready.resolve());
          child.once("exit", () => exited.resolve());
          child.once("error", ready.reject);
          return child;
        },
        scheduleTimeout: (callback) => {
          deadlines.add(callback);
          return () => {
            deadlines.delete(callback);
          };
        },
      },
    },
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await ready.promise;
  for (const expire of Array.from(deadlines)) expire();
  const blocked = await h.waitFor((run) => run.executionError === "git_quarantined");
  expect(blocked.phase).toBe("planning");
  expect(await new GitService().mutationState(h.repo)).toMatchObject({ status: "quarantined" });
  await exited.promise;
  await h.restart();
  await h.subscribe();
  const recovered = await h.waitFor((run) => run.executionError === "git_quarantined");
  expect(recovered.phase).toBe("planning");
  expect(recovered.dag).toEqual([]);
});
