import { expect, it } from "vitest";
import { CommandJobs, keptForMs, keptInAll, keptPerSession } from "./command-jobs.ts";

const minute = 60_000;
const ids = (jobs: CommandJobs<{ id: string; session: string }>, all: string[]) =>
  all.filter((id) => jobs.get(id) !== undefined);

it("a finished job stays readable for a while, then is let go; a running one is always kept", () => {
  const jobs = new CommandJobs();
  jobs.add({ id: "build", session: "s1" });
  jobs.add({ id: "server", session: "s1" });
  jobs.finished("build", 0);
  jobs.prune(keptForMs);
  expect(ids(jobs, ["build", "server"])).toEqual(["build", "server"]);
  jobs.prune(keptForMs + minute);
  expect(ids(jobs, ["build", "server"])).toEqual(["server"]);
  jobs.prune(100 * keptForMs);
  expect(jobs.running("s1").map((job) => job.id)).toEqual(["server"]);
});

it("only the newest finished jobs are kept, per session and in all", () => {
  const jobs = new CommandJobs();
  const one = Array.from({ length: keptPerSession + 3 }, (_, i) => `s1-${i}`);
  for (const [i, id] of one.entries()) {
    jobs.add({ id, session: "s1" });
    jobs.finished(id, i);
  }
  expect(ids(jobs, one)).toEqual(one.slice(3));

  const many = Array.from({ length: keptInAll + 5 }, (_, i) => `t-${i}`);
  for (const [i, id] of many.entries()) {
    jobs.add({ id, session: `session-${i}` });
    jobs.finished(id, 1000 + i);
  }
  expect(ids(jobs, [...one, ...many])).toEqual(many.slice(5));
});

it("a deleted session's jobs are let go at once, running or not", () => {
  const jobs = new CommandJobs();
  jobs.add({ id: "done", session: "gone" });
  jobs.finished("done", 0);
  jobs.add({ id: "running", session: "gone" });
  jobs.add({ id: "other", session: "kept" });
  expect(
    jobs
      .forget("gone")
      .map((job) => job.id)
      .toSorted(),
  ).toEqual(["done", "running"]);
  expect(ids(jobs, ["done", "running", "other"])).toEqual(["other"]);
});
