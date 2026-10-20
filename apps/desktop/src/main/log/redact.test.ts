import { describe, expect, it } from "vitest";
import { createDesktopLog } from "./desktop-log.ts";
import { createDesktopRedactor } from "./redact.ts";

/** The records the desktop log would write, captured from its console sink. */
function capture(env: Record<string, string> = {}) {
  const printed: string[] = [];
  const log = createDesktopLog({
    now: () => 0,
    console: (_level, text) => printed.push(text),
    redact: createDesktopRedactor({ home: "/Users/someone", env }),
  });
  return { log, printed };
}

describe("desktop log redaction", () => {
  it("keeps a Node warning from the daemon's stderr readable", () => {
    const { log, printed } = capture();
    log("daemon")(
      "warn",
      "(node:1877) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
      { stream: "stderr" },
    );
    expect(printed).toEqual([
      '[warn] daemon: (node:1877) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. {"stream":"stderr"}',
    ]);
  });

  it("keeps one line of a pretty-printed error readable", () => {
    const { log, printed } = capture();
    log("daemon")("warn", '    "values": [');
    log("daemon")("warn", 'Daemon cannot start: Service engine: {"code":"EADDRINUSE","port":4');
    expect(printed).toEqual([
      '[warn] daemon:     "values": [',
      '[warn] daemon: Daemon cannot start: Service engine: {"code":"EADDRINUSE","port":4',
    ]);
  });

  it("still removes secrets from text that only looks like JSON", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const { log, printed } = capture({ ACE_PAIRING_TOKEN: "pairing-value-0123456789" });
    log("daemon")("warn", `[auth] {"password":"plainpw-xyz", "token": "${token}",`);
    log("daemon")("warn", '[auth] {"credentials": {"user":"me","pw":"hunter22"');
    log("daemon")("warn", "[pairing] pairing-value-0123456789 at /Users/someone/x [");
    log("renderer")("info", "worker.failed", { detail: `[ws] {"token":"${token}"`, code: 1006 });
    const text = printed.join("\n");
    for (const secret of [token, "plainpw-xyz", "hunter22", "pairing-value-0123456789"])
      expect(text).not.toContain(secret);
    expect(text).not.toContain("/Users/someone");
    expect(printed[1]).toBe("[warn] daemon: [auth] {<SECRET>");
    expect(printed[3]).toContain('"code":1006');
  });

  it("replaces a value under a secret-named field whole", () => {
    const { log, printed } = capture();
    log("renderer")("info", "auth.refresh", { refreshToken: "[short]", attempt: 2 });
    expect(printed).toEqual([
      '[info] renderer: auth.refresh {"refreshToken":"<SECRET>","attempt":2}',
    ]);
  });
});
