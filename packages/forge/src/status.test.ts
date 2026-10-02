import { describe, expect, it } from "vitest";
import {
  mapPr,
  mapCheck,
  mapLegacyStatus,
  ciStatus,
  LogTail,
  repositoryFromRemote,
  nextPollDelay,
} from "./index.ts";
import { pr, check, repository } from "./testing/fixtures.ts";

describe("forge decisions", () => {
  it("keeps merge state ahead of closed state and draft separate from open", () => {
    const ref = { repository, number: 7 };
    expect(mapPr(ref, { ...pr, state: "closed", merged: true }, []).state).toBe("merged");
    expect(mapPr(ref, { ...pr, draft: true }, []).state).toBe("draft");
    expect(mapPr(ref, { ...pr, mergeable: null }, []).mergeability).toBe("unknown");
    expect(mapPr(ref, { ...pr, state: "future" }, []).state).toBe("unknown");
  });
  it("never reports success while a check is failing, cancelled, pending or unknown", () => {
    expect(ciStatus([mapCheck(check), mapCheck({ ...check, status: "in_progress" })])).toBe(
      "failure",
    );
    expect(ciStatus([mapCheck({ ...check, status: "in_progress", conclusion: "success" })])).toBe(
      "pending",
    );
    expect(ciStatus([mapCheck({ ...check, conclusion: "future" })])).toBe("unknown");
    expect(ciStatus([mapCheck({ ...check, conclusion: "cancelled" })])).toBe("failure");
    expect(ciStatus([mapCheck({ ...check, conclusion: "neutral" })])).toBe("success");
    expect(ciStatus([])).toBe("none");
    expect(
      mapLegacyStatus({
        id: 3,
        state: "error",
        context: "deploy",
        updated_at: "now",
        target_url: null,
      }).status,
    ).toBe("failure");
  });
  it("rejects invalid provider values and keeps future fields after redaction", () => {
    expect(() => mapCheck({ ...check, id: "11" })).toThrow("invalid_data");
    const mapped = mapPr({ repository, number: 7 }, { ...pr, extra: "ghp_secret123" }, []);
    expect(mapped.raw).toMatchObject({ future_field: { useful: true }, extra: "[REDACTED]" });
    expect(JSON.stringify(mapped)).not.toContain("ghp_secret123");
  });
  it("recognises SSH and HTTPS remotes including GitLab subgroups without trusting arbitrary hosts", () => {
    expect(repositoryFromRemote("git@github.com:octo/ace.git")).toEqual(repository);
    expect(repositoryFromRemote("https://github.com/octo/ace.git")).toEqual(repository);
    expect(repositoryFromRemote("ssh://git@gitlab.com/team/sub/ace.git")).toMatchObject({
      forge: "gitlab",
      owner: "team/sub",
    });
    expect(() => repositoryFromRemote("https://evil.test/octo/ace")).toThrow("unsupported");
    expect(() => repositoryFromRemote("git@github.com:../ace.git")).toThrow("unsupported");
  });
  it("caps streaming tails by bytes, redacts split tokens, and keeps the newest output", () => {
    const tail = new LogTail(80);
    tail.write(Buffer.from("old\n".repeat(100)));
    tail.write(Buffer.from("ghp_super"));
    tail.write(Buffer.from("Secret123\n"));
    tail.write(Buffer.from("last é line\n"));
    const result = tail.finish();
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(80);
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("superSecret");
    expect(result.text.endsWith("last é line\n")).toBe(true);
    expect(result.truncated).toBe(true);
    const huge = new LogTail(100);
    huge.write(Buffer.from("x".repeat(100_000)));
    huge.write(Buffer.from("\nlast\n"));
    expect(huge.finish()).toEqual({
      text: "[oversized log line omitted]\nlast\n",
      truncated: true,
    });
  });
  it("backs off exponentially, caps normal retries, and honours server deadlines", () => {
    expect(nextPollDelay(0, 0, undefined)).toBe(15_000);
    expect(nextPollDelay(2, 0, undefined)).toBe(60_000);
    expect(nextPollDelay(20, 0, undefined)).toBe(300_000);
    expect(nextPollDelay(1, 1_000, 901_000)).toBe(900_000);
  });
});
