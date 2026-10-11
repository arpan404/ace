import { chmod } from "node:fs/promises";
import { expect, test } from "vitest";
import { GhApi } from "./http.ts";
import { fakeGh, standard } from "./testing/fixtures.ts";

const mutation = { query: "mutation { enablePullRequestAutoMerge(input:{pullRequestId:\"PR_7\"}) { clientMutationId } }" };
const accepted = { data: { enablePullRequestAutoMerge: { clientMutationId: "accepted" } } };
const refusals = [
  { type: "RATE_LIMITED", kind: "rate_limit" },
  { type: "FORBIDDEN", kind: "forbidden" },
  { type: "UNAUTHORIZED", kind: "forbidden" },
  { type: "NOT_FOUND", kind: "not_found" },
  { type: "GRAPHQL_VALIDATION_FAILED", kind: "invalid_data" },
] as const;

for (const refusal of refusals) {
  test(`HTTP 200 GraphQL ${refusal.type} with gh exit 1 is a definite refusal for linked PR reads and writes`, async () => {
    const fixtures = standard();
    fixtures.graphql = [
      { code: 1, body: { errors: [{ type: refusal.type, message: "Provider refusal" }] } },
      { code: 1, body: { data: { enablePullRequestAutoMerge: null }, errors: [{ extensions: { code: refusal.type }, message: "Provider refusal" }] } },
      { body: accepted },
    ];
    const f = await fakeGh(fixtures);
    try {
      const signal = new AbortController().signal;
      await expect(f.forge.states([7], signal)).rejects.toMatchObject({ kind: refusal.kind });
      const api = new GhApi({ runner: f.runner, command: f.executable, host: "github.com", now: () => 1000 });
      await expect(api.request("graphql", signal, mutation)).rejects.toMatchObject({
        kind: refusal.kind,
        ...(refusal.kind === "rate_limit" ? { retryAt: 61000 } : {}),
      });
      expect((await api.request("graphql", signal, mutation)).body).toEqual(accepted);
    } finally { await f.cleanup(); }
  });
}

test("GraphQL partial data, unknown errors and unreadable bodies cannot settle a dispatched write as refused", async () => {
  for (const response of [
    { code: 1, body: { ...accepted, errors: [{ type: "FORBIDDEN", message: "Another field refused" }] } },
    { code: 1, body: { errors: [{ type: "FUTURE_ERROR", message: "Unknown outcome" }] } },
    { code: 1, raw: '{"errors":[{"type":"FORBIDDEN"' },
    { code: 0, body: { ...accepted, errors: [{ type: "RATE_LIMITED" }] } },
  ]) {
    const f = await fakeGh({ graphql: [response] });
    try {
      const api = new GhApi({ runner: f.runner, command: f.executable, host: "github.com", now: () => 1000 });
      await expect(api.request("graphql", new AbortController().signal, mutation)).rejects.toMatchObject({ kind: "outcome_uncertain" });
    } finally { await f.cleanup(); }
  }
});

test("a missing or nonexecutable CLI cannot make a GraphQL mutation uncertain and restoring it permits retry", async () => {
  const f = await fakeGh({ graphql: [{ body: accepted }] });
  try {
    const api = new GhApi({ runner: f.runner, command: f.executable + "-absent", host: "github.com", now: () => 1000 });
    const signal = new AbortController().signal;
    await expect(api.request("graphql", signal, mutation)).rejects.toMatchObject({ kind: "cli" });
    const installed = new GhApi({ runner: f.runner, command: f.executable, host: "github.com", now: () => 1000 });
    await chmod(f.executable, 0o644);
    await expect(installed.request("graphql", signal, mutation)).rejects.toMatchObject({ kind: "cli" });
    await chmod(f.executable, 0o755);
    expect((await installed.request("graphql", signal, mutation)).body).toEqual(accepted);
  } finally { await f.cleanup(); }
});
