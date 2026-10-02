import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createGhClient,
  pollGithub,
  AutomationService,
  AutomationStore,
  type GithubTrigger,
  type GhResponse,
  type TimerDriver,
} from "./index.ts";
import type { Automation } from "@ace/protocol";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) dispose();
});
const trigger = (event: GithubTrigger["event"]): GithubTrigger => ({
  kind: "github",
  repository: "user/project",
  event,
  pollIntervalMs: 60_000,
});
const resource = (id = 1, version = "2024-01-01T00:00:00Z") => ({
  id,
  number: id,
  updated_at: version,
  html_url: `https://github.com/user/project/pull/${id}`,
  title: "Review",
  body: "Untrusted {{value}}",
});
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), "ace-fake-gh-"));
  const binary = join(dir, "gh.mjs"),
    fixtures = join(dir, "responses.json"),
    log = join(dir, "calls.jsonl");
  const source = `#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const endpoint=args[args.indexOf('--include')+1];
const response=JSON.parse(readFileSync(${JSON.stringify(fixtures)},'utf8'))[endpoint];
if(!response){process.stderr.write('unknown endpoint');process.exit(1);}
const conditional=args.find(a=>a.startsWith('If-None-Match: '));
if(conditional==='If-None-Match: '+response.etag){process.stdout.write('HTTP/2.0 304 Not Modified\\r\\nETag: '+response.etag+'\\r\\n\\r\\n');process.exit(1);}
const link=response.next?'Link: <https://api.github.com/'+response.next+'>; rel="next"\\r\\n':'';
process.stdout.write('HTTP/2.0 200 OK\\r\\nETag: '+response.etag+'\\r\\n'+link+'\\r\\n'+JSON.stringify(response.data));
`;
  writeFileSync(binary, source);
  chmodSync(binary, 0o700);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    client: createGhClient({ binary }),
    respond: (responses: Record<string, { etag: string; data: unknown; next?: string }>) =>
      writeFileSync(fixtures, JSON.stringify(responses)),
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
const pulls = "repos/user/project/pulls?state=all&sort=updated&direction=desc&per_page=100";
it("uses gh conditional GETs, establishes a baseline and emits only changed PRs", async () => {
  const gh = fakeGh();
  gh.respond({ [pulls]: { etag: '"v1"', data: [resource()] } });
  const first = await pollGithub(gh.client, trigger("pr_changed"), {});
  expect(first.events).toEqual([]);
  const unchanged = await pollGithub(gh.client, trigger("pr_changed"), first.state);
  expect(unchanged.events).toEqual([]);
  expect(gh.calls()[1]).toContain('If-None-Match: "v1"');
  expect(gh.calls()[0]).toContain("github.com");
  gh.respond({
    [pulls]: { etag: '"v2"', data: [resource(1, "2024-01-02T00:00:00Z"), resource(2)] },
  });
  const changed = await pollGithub(gh.client, trigger("pr_changed"), unchanged.state);
  expect(changed.events.map((event) => event.key)).toEqual([
    "github:pr_changed:1:2024-01-02T00:00:00Z",
    "github:pr_changed:2:2024-01-01T00:00:00Z",
  ]);
  expect(changed.events[0]?.variables.body).toBe("Untrusted {{value}}");
  expect((await pollGithub(gh.client, trigger("pr_changed"), changed.state)).events).toEqual([]);
});
it("retains all conditional pages and does not duplicate resources that move pages", async () => {
  const gh = fakeGh(),
    page2 = "repos/user/project/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2";
  gh.respond({
    [pulls]: { etag: '"one"', data: [resource()], next: page2 },
    [page2]: { etag: '"two"', data: [resource(2)] },
  });
  const baseline = await pollGithub(gh.client, trigger("pr_changed"), {});
  gh.respond({
    [pulls]: {
      etag: '"new"',
      data: [resource(1, "2024-01-02T00:00:00Z"), resource(2)],
      next: page2,
    },
    [page2]: { etag: '"two"', data: [resource(2)] },
  });
  const changed = await pollGithub(gh.client, trigger("pr_changed"), baseline.state);
  expect(changed.events).toHaveLength(1);
  expect(gh.calls().at(-1)).toContain('If-None-Match: "two"');
});
it("emits failed CI runs only for the configured pull request", async () => {
  let data: unknown = { workflow_runs: [] };
  const client = {
    async get(): Promise<GhResponse> {
      return { status: 200, etag: undefined, next: undefined, data };
    },
  };
  const t = { ...trigger("ci_failed"), pullRequest: 42 };
  const first = await pollGithub(client, t, {});
  data = {
    workflow_runs: [
      { ...resource(1), conclusion: "failure", pull_requests: [{ number: 42 }] },
      { ...resource(2), conclusion: "success", pull_requests: [{ number: 42 }] },
      { ...resource(3), conclusion: "failure", pull_requests: [{ number: 7 }] },
    ],
  };
  const current = await pollGithub(client, t, first.state);
  expect(current.events).toHaveLength(1);
  expect(current.events[0]?.variables.pull_requests).toBe("42");
});
it("emits review comments and newly applied matching issue labels", async () => {
  let data: unknown = [];
  const client = {
    async get(): Promise<GhResponse> {
      return { status: 200, etag: undefined, next: undefined, data };
    },
  };
  const review = { ...trigger("review_comment"), pullRequest: 42 };
  let before = await pollGithub(client, review, {});
  data = [
    { ...resource(), pull_request_url: "https://api.github.com/repos/user/project/pulls/42" },
  ];
  expect((await pollGithub(client, review, before.state)).events[0]?.key).toContain(
    "review_comment",
  );
  const issue = { ...trigger("issue_labelled"), label: "fix" };
  data = [{ ...resource(), labels: [{ name: "old" }] }];
  before = await pollGithub(client, issue, {});
  data = [
    {
      ...resource(1, "2024-01-02T00:00:00Z"),
      labels: [{ name: "old" }, { name: "fix" }, { name: "unrelated" }],
    },
    { ...resource(2), pull_request: {}, labels: [{ name: "fix" }] },
  ];
  const current = await pollGithub(client, issue, before.state);
  expect(current.events).toHaveLength(1);
  expect(current.events[0]?.variables.label).toBe("fix");
  data = [{ ...resource(1, "2024-01-03T00:00:00Z"), labels: [{ name: "old" }, { name: "fix" }] }];
  expect((await pollGithub(client, issue, current.state)).events).toEqual([]);
});
it("persists GitHub ETags and run deduplication through a service restart", async () => {
  const gh = fakeGh(),
    store = new AutomationStore(join(gh.dir, "automations.sqlite"));
  let now = Date.parse("2024-01-01T00:00:00Z"),
    id = 0;
  let callback: (() => void | Promise<void>) | undefined;
  const timer: TimerDriver = {
    arm(_delay, cb) {
      callback = cb;
      return () => {
        callback = undefined;
      };
    },
  };
  const prompts: string[] = [];
  const deps = {
    now: () => now,
    random: () => 0,
    id: () => `gh-run-${++id}`,
    timer,
    onError: (e: unknown) => {
      throw e;
    },
    executor: {
      async execute(input: { prompt: string }) {
        prompts.push(input.prompt);
        return { threadId: "thread", status: "succeeded" as const, result: "CI fixed" };
      },
      async recover() {
        return undefined;
      },
    },
  };
  let service = new AutomationService(store, deps, gh.client);
  cleanup.push(() => {
    service.stop();
    store.close();
  });
  service.start();
  const automation: Automation = {
    id: "github",
    title: "PR triage",
    provider: "codex",
    workspace: "/project",
    enabled: true,
    prompt: "Review {{number}}",
    worktree: true,
    trigger: trigger("pr_changed"),
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  };
  gh.respond({ [pulls]: { etag: '"v1"', data: [resource()] } });
  service.put(automation);
  await callback?.();
  await service.settled();
  expect(prompts).toEqual([]);
  now += 60_000;
  gh.respond({ [pulls]: { etag: '"v2"', data: [resource(1, "2024-01-02T00:00:00Z")] } });
  await callback?.();
  await service.settled();
  expect(prompts).toEqual(["Review 1"]);
  service.stop();
  service = new AutomationService(store, deps, gh.client);
  service.start();
  now += 60_000;
  await callback?.();
  await service.settled();
  expect(gh.calls().at(-1)).toContain('If-None-Match: "v2"');
  expect(service.inbox().runs).toMatchObject([{ status: "succeeded", result: "CI fixed" }]);
  expect(prompts).toHaveLength(1);
});
it("rejects untrusted endpoints, header injection and oversized process output", async () => {
  const gh = fakeGh();
  expect(() => gh.client.get("https://attacker.example")).toThrow("endpoint");
  expect(() => gh.client.get(pulls, "bad\r\nHeader: injected")).toThrow("ETag");
  gh.respond({ [pulls]: { etag: '"v1"', data: [{ ...resource(), body: "x".repeat(5000) }] } });
  const bounded = createGhClient({ binary: join(gh.dir, "gh.mjs"), maxBytes: 1024 });
  await expect(bounded.get(pulls)).rejects.toThrow("byte limit");
});
it("rejects malformed resource data", async () => {
  const gh = fakeGh();
  gh.respond({ [pulls]: { etag: '"bad"', data: [{ id: "not an ID" }] } });
  await expect(pollGithub(gh.client, trigger("pr_changed"), {})).rejects.toThrow();
});
it("rejects pagination loops and cross-repository next pages", async () => {
  const t = trigger("pr_changed");
  const base = { status: 200, etag: undefined, data: [] };
  await expect(
    pollGithub(
      {
        async get() {
          return { ...base, next: pulls };
        },
      },
      t,
      {},
    ),
  ).rejects.toThrow("window");
  await expect(
    pollGithub(
      {
        async get() {
          return { ...base, next: "repos/other/project/pulls?page=2" };
        },
      },
      t,
      {},
    ),
  ).rejects.toThrow("repository");
});
it("cancels a gh child when its owning operation is aborted", async () => {
  const gh = fakeGh();
  writeFileSync(join(gh.dir, "gh.mjs"), "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n");
  const controller = new AbortController();
  const request = gh.client.get(pulls, undefined, controller.signal);
  controller.abort();
  await expect(request).rejects.toThrow("aborted");
});
