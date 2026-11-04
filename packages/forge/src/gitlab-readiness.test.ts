import { describe, expect, it } from "vitest";
import { gitlabReadiness } from "./gitlab-readiness.ts";
import { ForgeError } from "./errors.ts";
import type { CommandRunner, CommandRequest, CommandResult } from "./command.ts";

const preferences = {
  hosts: [{ host: "gitlab.com", forge: "gitlab" as const }],
  host: "gitlab.com",
  remote: "origin",
};
const signal = () => new AbortController().signal;

function fakeRunner(handler: (request: CommandRequest) => CommandResult): {
  runner: CommandRunner;
  requests: CommandRequest[];
} {
  const requests: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    requests.push(request);
    return handler(request);
  };
  return { runner, requests };
}

function http(status: string, headers: Record<string, string>, body: string): string {
  const lines = [`HTTP/2.0 ${status}`];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

function ready(
  handler: (request: CommandRequest) => {
    code: number | null;
    stdout: string;
    truncated?: boolean;
    unreachable?: true;
  },
) {
  return fakeRunner((request) => ({ truncated: false, ...handler(request) }));
}

const version = { code: 0, stdout: "glab version 1.55.0 (2025-01-01)\n" };
const user = (username: string, headers: Record<string, string> = {}) => ({
  code: 0,
  stdout: http("200 OK", headers, JSON.stringify({ username })),
});

describe("gitlab readiness", () => {
  it("reports ready after version and user probes", async () => {
    const f = ready((request) => (request.args[0] === "--version" ? version : user("octo")));
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({
      cli: "available",
      version: "1.55.0",
      account: "octo",
      accounts: [{ login: "octo", active: true }],
      api: "ready",
      transport: "unchecked",
    });
    expect(status.instructions).toContain("GitLab API access verified as octo");
    expect(f.requests.map((request) => `${request.command} ${request.args.join(" ")}`)).toEqual([
      "glab --version",
      "glab api user --hostname gitlab.com --include",
    ]);
  });

  it("asks to install glab when the CLI is missing", async () => {
    const f = fakeRunner(() => {
      throw new ForgeError("cli");
    });
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status.cli).toBe("unavailable");
    expect(status.api).toBe("unavailable");
    expect(status.instructions).toContain("Install GitLab CLI");
  });

  it("stays unavailable when glab --version fails", async () => {
    const f = ready(() => ({ code: 1, stdout: "" }));
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({ cli: "unavailable", api: "unavailable", account: null });
  });

  it("asks to log in on 401", async () => {
    const f = ready((request) =>
      request.args[0] === "--version"
        ? version
        : { code: 1, stdout: http("401 Unauthorized", {}, "{}") },
    );
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({ cli: "available", api: "login_required", account: null });
    expect(status.instructions).toContain("glab auth login --hostname gitlab.com");
  });

  it("reports an inconclusive check when glab exits without an HTTP response", async () => {
    const f = ready((request) =>
      request.args[0] === "--version" ? version : { code: 1, stdout: "" },
    );
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({ cli: "available", api: "unavailable", account: null });
  });

  it("reports an expected-account mismatch without switching", async () => {
    const f = ready((request) => (request.args[0] === "--version" ? version : user("other")));
    const status = await gitlabReadiness(
      f.runner,
      {
        ...preferences,
        hosts: [{ host: "gitlab.com", forge: "gitlab" as const, account: "octo" }],
      },
      signal(),
    );
    expect(status.api).toBe("account_mismatch");
    expect(status.account).toBe("other");
    expect(status.instructions).toContain("octo");
  });

  it("maps unreachable output to offline, never to a sign-in answer", async () => {
    const f = fakeRunner((request) =>
      request.args[0] === "--version"
        ? { ...version, truncated: false }
        : { code: 1, stdout: "", truncated: false, unreachable: true as const },
    );
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({ cli: "available", api: "offline", account: null });
    expect(status.instructions).toContain("couldn't reach gitlab.com");
  });

  it("maps 429 to rate_limited without matching the body", async () => {
    const f = ready((request) =>
      request.args[0] === "--version"
        ? version
        : { code: 1, stdout: http("429 Too Many Requests", { "retry-after": "30" }, "{}") },
    );
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({ api: "rate_limited", account: null });
  });

  it("maps 403 with quota headers to rate_limited, otherwise unavailable", async () => {
    const limited = ready((request) =>
      request.args[0] === "--version"
        ? version
        : {
            code: 1,
            stdout: http("403 Forbidden", { "x-ratelimit-remaining": "0" }, "{}"),
          },
    );
    expect(await gitlabReadiness(limited.runner, preferences, signal())).toMatchObject({
      api: "rate_limited",
      account: null,
    });
    const denied = ready((request) =>
      request.args[0] === "--version"
        ? version
        : { code: 1, stdout: http("403 Forbidden", {}, "{}") },
    );
    expect(await gitlabReadiness(denied.runner, preferences, signal())).toMatchObject({
      api: "unavailable",
      account: null,
    });
  });

  it("maps 404 and 500 to unavailable, never to login_required", async () => {
    for (const response of ["404 Not Found", "500 Internal Server Error"]) {
      const f = ready((request) =>
        request.args[0] === "--version" ? version : { code: 1, stdout: http(response, {}, "{}") },
      );
      const status = await gitlabReadiness(f.runner, preferences, signal());
      expect(status).toMatchObject({ cli: "available", api: "unavailable", account: null });
    }
  });

  it("maps malformed identity to unavailable, never to ready", async () => {
    const bodies = ["not json", "{}", JSON.stringify({ username: "-bad" })];
    for (const body of bodies) {
      const f = ready((request) =>
        request.args[0] === "--version" ? version : { code: 0, stdout: http("200 OK", {}, body) },
      );
      const status = await gitlabReadiness(f.runner, preferences, signal());
      expect(status).toMatchObject({ api: "unavailable", account: null });
    }
  });

  it("never reports ready from a truncated user response", async () => {
    const f = fakeRunner((request) =>
      request.args[0] === "--version"
        ? { ...version, truncated: false }
        : {
            code: 0,
            stdout: http("200 OK", {}, JSON.stringify({ username: "octo" })),
            truncated: true,
          },
    );
    const status = await gitlabReadiness(f.runner, preferences, signal());
    expect(status).toMatchObject({ api: "unavailable", account: null });
  });

  it("lets cancellation propagate instead of reporting a status", async () => {
    const controller = new AbortController();
    const f = fakeRunner(() => {
      throw new ForgeError("cancelled");
    });
    controller.abort();
    await expect(gitlabReadiness(f.runner, preferences, controller.signal)).rejects.toThrow();
  });

  it.each(["john.smith_1", "john-smith"])("verifies account %s through glab", async (account) => {
    const f = ready((request) => (request.args[0] === "--version" ? version : user(account)));
    expect(await gitlabReadiness(f.runner, preferences, signal())).toMatchObject({
      api: "ready",
      account,
    });
  });
});
