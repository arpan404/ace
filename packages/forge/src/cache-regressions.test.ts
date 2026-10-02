import { expect, it } from "vitest";
import { fakeGh, standard, pr, check, comment, sha } from "./testing/fixtures.ts";

it("reuses immutable status and collection revisions until their resource changes", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    { body: pr, headers: { ETag: '"pr"' } },
    { status: 304, raw: "" },
  ];
  fixtures[`repos/octo/ace/commits/${sha}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [check] }, headers: { ETag: '"check"' } },
    { status: 304, raw: "" },
  ];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
    { body: [comment], headers: { ETag: '"comment"' } },
    { status: 304, raw: "" },
    { body: [{ ...comment, body: "Changed feedback" }] },
  ];
  const fake = await fakeGh(fixtures);
  try {
    const signal = new AbortController().signal;
    const first = await fake.forge.status(7, signal);
    const second = await fake.forge.status(7, signal);
    expect(second).toBe(first);
    expect(() => {
      second.comments.push(
        second.comments[0] ?? {
          kind: "inline",
          id: 1,
          body: "bad",
          author: "bad",
          file: null,
          line: null,
          updatedAt: "now",
          replyTo: null,
        },
      );
    }).toThrow();
    const third = await fake.forge.status(7, signal);
    expect(third).not.toBe(first);
    expect(third.comments[0]?.body).toBe("Changed feedback");
    expect(third.checks).toBe(first.checks);
    expect(first.comments[0]?.body).toBe("Handle empty input");
  } finally {
    await fake.cleanup();
  }
});
it("keeps both unknown values when secret-bearing object keys redact to the same text", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    { body: { ...pr, ghp_keyone: { value: 1 }, ghp_keytwo: { value: 2 } } },
  ];
  const fake = await fakeGh(fixtures);
  try {
    const status = await fake.forge.status(7, new AbortController().signal);
    const raw = JSON.stringify(status.raw);
    expect(raw).toContain('"value":1');
    expect(raw).toContain('"value":2');
    expect(raw).not.toContain("ghp_keyone");
    expect(raw).not.toContain("ghp_keytwo");
  } finally {
    await fake.cleanup();
  }
});
it("redacts generic access-token assignments across streamed chunk boundaries", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/actions/jobs/99/logs"] = [
    {
      repeat: 1,
      text: "access_token=opaque-demo-token\nrefresh-token: another-secret\n",
      suffix: "final failure\n",
    },
  ];
  const fake = await fakeGh(fixtures);
  try {
    const tail = await fake.forge.logTail(99, new AbortController().signal);
    expect(tail.text).not.toContain("opaque-demo-token");
    expect(tail.text).not.toContain("another-secret");
    expect(tail.text.endsWith("final failure\n")).toBe(true);
  } finally {
    await fake.cleanup();
  }
});
