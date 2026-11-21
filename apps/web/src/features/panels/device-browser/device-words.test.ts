import { describe, expect, it } from "vitest";
import { deviceTabProblem } from "./device-words.ts";

const failure = (tunnel: Parameters<typeof deviceTabProblem>[0]["tunnel"], port?: number) => ({
  url: "http://localhost:3000/",
  code: -120,
  description: "ERR_SOCKS_CONNECTION_FAILED",
  tunnel,
  ...(port === undefined ? {} : { port }),
});

describe("a device tab's page that didn't load", () => {
  it.each([
    ["off", 3000, "This machine's localhost is off for your devices", /More options/],
    ["forbidden", 3000, "This computer can't open the machine's localhost", /full access/],
    ["refused", 4317, "Port 4317 is ace's own", /your app's port/],
    ["limit", 3000, "Too many connections to the machine at once", /Close a few/],
    ["offline", 3000, "The machine is offline", /reaches it again/],
    ["closed", 5173, "Nothing is running on port 5173 on the machine", /Start the server/],
  ] as const)("the tunnel said %s", (tunnel, port, title, detail) => {
    const problem = deviceTabProblem(failure(tunnel, port));
    expect(problem.title).toBe(title);
    expect(problem.detail).toMatch(detail);
  });

  it("names the port it can't name as that port", () => {
    expect(deviceTabProblem(failure("closed")).title).toBe(
      "Nothing is running on that port on the machine",
    );
  });

  it("says what the browser says when the machine gave no reason", () => {
    const problem = deviceTabProblem({
      url: "https://example.com/",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    expect(problem.title).not.toMatch(/machine/);
    expect(problem.code).toBe("ERR_NAME_NOT_RESOLVED");
  });
});
