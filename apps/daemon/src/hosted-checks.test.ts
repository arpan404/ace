import { expect, it } from "vitest";
import { HostedChecks } from "./hosted-checks.ts";
import { ForgeHostedChecksCommand } from "@ace/protocol";
import { isAdmittedApiRequest, type CommandRunner, type HostApiWrite } from "@ace/forge";

const repository = { forge: "gitlab" as const, host: "gitlab.com", owner: "acme", name: "repo" };
const abort = () => new AbortController().signal;
const command = (jobs: "failed" | "all" = "failed") =>
  ForgeHostedChecksCommand.parse({
    type: "forge.hosted.checks",
    workspaceId: "ws-checks",
    pr: { repository, number: 7 },
    action: { kind: "rerun", runId: 9, attempt: 12, jobs },
  });
function fixture(options: { denied?: boolean; lost?: boolean; partial?: boolean } = {}) {
  let writes = 0;
  let id = 12;
  const sha = "a".repeat(40);
  const pipeline = { id: 9, status: "failed", sha };
  const job = (jobId: number) => ({
    id: jobId,
    name: "test",
    status: jobId > 12 ? "pending" : "failed",
    pipeline,
  });
  const hostRunner = async (
    _cwd: string,
    _repository: typeof repository,
    admitted: readonly HostApiWrite[],
  ): Promise<CommandRunner> => {
    if (admitted.length && options.denied) throw new Error("repository_hidden");
    return async (request) => {
      if (!isAdmittedApiRequest("glab", request, repository.host, admitted))
        throw new Error("unadmitted");
      const path = request.args[1] ?? "";
      const write = request.input !== undefined;
      if (write) {
        request.dispatch?.record();
        writes++;
        id = 13;
        if (options.lost) throw new Error("lost response");
      }
      const body = path.includes("/jobs?")
        ? options.partial
          ? [job(11), job(id)]
          : [job(id)]
        : path.endsWith("/trace")
          ? "test failed\n"
          : path.includes("/jobs/")
            ? job(12)
            : pipeline;
      return {
        code: 0,
        stdout: `HTTP/2.0 200 OK\r\nX-Next-Page: \r\n\r\n${typeof body === "string" ? body : JSON.stringify(body)}`,
        truncated: false,
      };
    };
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected GitHub route");
  };
  const router = new HostedChecks({
    backends: { hostRunner, backend: unsupported, writer: unsupported },
  });
  return { router, writes: () => writes };
}

it("routes GitLab check detail through admitted reads", async () => {
  const f = fixture();
  expect(await f.router.read("/repo", repository, 12, undefined, abort())).toMatchObject({
    id: 12,
    workflow: { runId: 9, attempt: 12 },
    log: { text: "test failed" },
  });
  expect(f.writes()).toBe(0);
});
it("refuses hidden repositories before any pipeline write", async () => {
  const f = fixture({ denied: true });
  await expect(f.router.execute(command(), "/repo", abort(), () => true)).rejects.toThrow(
    "repository_hidden",
  );
  expect(f.writes()).toBe(0);
});
it("serializes simultaneous retries and leaves the newer attempt alone", async () => {
  const f = fixture();
  await Promise.all([
    f.router.execute(command(), "/repo", abort(), () => true),
    f.router.execute(command(), "/repo", abort(), () => true),
  ]);
  expect(f.writes()).toBe(1);
});
it("settles a lost pipeline retry response from the new job attempt", async () => {
  const f = fixture({ lost: true });
  await expect(f.router.execute(command(), "/repo", abort(), () => true)).resolves.toBeUndefined();
  expect(f.writes()).toBe(1);
});
it("keeps a partial retry of all jobs uncertain after a lost response", async () => {
  const f = fixture({ lost: true, partial: true });
  await expect(f.router.execute(command("all"), "/repo", abort(), () => true)).rejects.toThrow(
    "action_outcome_uncertain",
  );
  expect(f.writes()).toBe(1);
});
