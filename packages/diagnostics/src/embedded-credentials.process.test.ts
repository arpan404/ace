import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRedactor, createTextRedactor } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { createFileSink, createLogger, logFields, logMetadata, logError } from "@ace/diagnostics";
import { temporary, controlledWorker } from "./test-support.ts";

const secret = "OPAQUE_CLI_CREDENTIAL";
const payload = { credentials: { login: secret }, code: 7, inputTokens: 12 };
const diagnostics = [
  `request failed: ${JSON.stringify(payload)}`,
  `request failed: ${JSON.stringify(JSON.stringify(payload))}`,
  `request failed: {"credentials":{"login":"${secret}"`,
];

it.each([false, true])(
  "logger error preparation protects configured secrets in recent and saved output with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const value = 'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right';
    const context = { env: { CUSTOM: value } };
    const log = createLogger({
      sink: await createFileSink(
        { directory, fileBytes: 65536, totalBytes: 131072, context },
        worker ? controlledWorker : undefined,
      ),
      now: () => 1,
      redact: createDiagnosticRedactor(context),
    });
    try {
      const error = Object.assign(new Error(`request failed: ${value}`), { code: "EIO" });
      log.log("error", "Engine failure", logError(error));
      log.child("engine").log("error", "Automatic Error", error);
      log.log("error", "Automatic error object", { message: error.message, code: "EIO" });
      log.log("error", "Nested error", logFields([["error", error]]));
      await log.flush();
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      const recent = log.recent();
      expect(recent).toHaveLength(4);
      for (const bytes of [saved, ...recent]) {
        expect(bytes).not.toContain("OPAQUE_ENV_CREDENTIAL");
        expect(bytes).toContain("request failed");
        expect(bytes).toContain("<ENV>");
        expect(bytes).toContain("EIO");
      }
    } finally {
      await log.close();
    }
  },
);

it.each([false, true])(
  "overlapping values and consumed container openers cannot leak through file logging with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const context = {
      env: {
        FIRST: "left{",
        SECOND: '{ "value": "OPAQUE_ENV_CREDENTIAL" }right',
        PREFIX: 'lead{"credentials":',
      },
    };
    const log = createLogger({
      sink: await createFileSink(
        { directory, fileBytes: 65536, totalBytes: 131072, context },
        worker ? controlledWorker : undefined,
      ),
      now: () => 1,
      redact: createDiagnosticRedactor(context),
    });
    try {
      log.log("warn", 'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right');
      log.log(
        "warn",
        "Provider diagnostic",
        logFields([
          ["stderr", 'lead{"credentials":{"login":"OPAQUE_CONTAINER_CREDENTIAL"},"code":7}'],
        ]),
      );
      await log.flush();
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(log.recent()).toHaveLength(2);
      for (const bytes of [saved, log.recent().join("\n")]) {
        expect(bytes).not.toContain("OPAQUE");
        expect(bytes).toContain("Provider diagnostic");
        expect(bytes).toContain("<ENV>");
      }
    } finally {
      await log.close();
    }
  },
);

it.each([false, true])(
  "file logging protects nested configured objects and prepared metadata with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const object = '{ "value": "OPAQUE_ENV_CREDENTIAL" }';
    const value = `left${object}right`;
    const context = { env: { OBJECT: object, CUSTOM: value, KEY: "credentials" } };
    const sink = await createFileSink(
      { directory, fileBytes: 65536, totalBytes: 131072, context },
      worker ? controlledWorker : undefined,
    );
    try {
      const nested = `request failed: {"payload": ${object},"credentials":{"login":"OPAQUE_OTHER_CREDENTIAL"},"code":7}`;
      const prepared = logMetadata(
        { stderr: `request failed: ${value}` },
        createDiagnosticRedactor(context),
      );
      await sink.write([
        {
          at: 1,
          level: "warn",
          component: "provider",
          message: "Provider diagnostic",
          data: { stderr: nested },
        },
        {
          at: 1,
          level: "warn",
          component: "provider",
          message: "Provider diagnostic",
          data: { raw: [prepared] },
        },
      ]);
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(saved).not.toContain("OPAQUE");
      expect(saved).toContain("request failed");
      expect(saved).toContain("<ENV>");
      expect(saved).toContain("<SECRET>");
      expect(saved).toContain("code");
      expect(saved).toContain("7");
    } finally {
      await sink.close();
    }
  },
);

it.each([false, true])(
  "file logging masks entire credentials despite an environment header-name match with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const sink = await createFileSink(
      {
        directory,
        fileBytes: 65536,
        totalBytes: 131072,
        context: { env: { CUSTOM: "Authorization" } },
      },
      worker ? controlledWorker : undefined,
    );
    try {
      await sink.write([
        {
          at: 1,
          level: "warn",
          component: "provider",
          message: 'Authorization: "OPAQUE_HEADER_CREDENTIAL"',
          data: { stderr: 'Authorization: "OPAQUE_HEADER_CREDENTIAL"' },
        },
      ]);
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(saved).not.toContain("OPAQUE_HEADER_CREDENTIAL");
      expect(saved).toContain("<SECRET>");
    } finally {
      await sink.close();
    }
  },
);

it.each([false, true])(
  "file logging removes configured JSON-fragment secrets with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const values = [
      'left{ "value": "OPAQUE_ENV_CREDENTIAL" }right',
      'left{ "value": "OPAQUE\\u005fENV_CREDENTIAL" }right',
    ];
    const sink = await createFileSink(
      {
        directory,
        fileBytes: 65536,
        totalBytes: 131072,
        context: { env: { CUSTOM: values[0], ESCAPED: values[1] } },
      },
      worker ? controlledWorker : undefined,
    );
    try {
      await sink.write(
        values
          .flatMap((value) => [value, JSON.stringify(value)])
          .map((value) => ({
            at: 1,
            level: "warn",
            component: "provider",
            message: `request failed: ${value}`,
            data: { stderr: `request failed: ${value}` },
          })),
      );
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(saved).not.toContain("OPAQUE_ENV_CREDENTIAL");
      expect(saved).not.toContain("OPAQUE");
      expect(saved).toContain("request failed");
      expect(saved).toContain("<ENV>");
    } finally {
      await sink.close();
    }
  },
);

it("provider stderr credentials disappear before recent diagnostic evidence is returned", async () => {
  const logger = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 1,
    redact: createRedactor({}),
  });
  try {
    for (const stderr of diagnostics)
      logger.log(
        "warn",
        "Provider exit",
        logFields([["evidence", logMetadata({ stderr }, createDiagnosticRedactor({}))]]),
      );
    const recent = logger.recent().join("\n");
    expect(recent).not.toContain(secret);
    expect(recent).toContain("request failed");
    expect(recent).toContain("INVALID STRUCTURED DATA OMITTED");
  } finally {
    await logger.close();
  }
});

it.each([false, true])(
  "file logging scrubs embedded credentials with worker=%s",
  async (worker) => {
    const directory = await temporary();
    const context = {
      home: "/private/home",
      workspace: "/private/home/repo",
      env: { CUSTOM: "opaque-env" },
    };
    const sink = await createFileSink(
      { directory, fileBytes: 65536, totalBytes: 131072, context },
      worker ? controlledWorker : undefined,
    );
    try {
      await sink.write(
        diagnostics.map((text) => ({
          at: 1,
          level: "warn",
          component: "provider",
          message: "Provider exit",
          data: {
            stderr: createTextRedactor(context)(text),
            path: "/private/home/repo/file",
            env: "opaque-env",
          },
        })),
      );
      const saved = await readFile(join(directory, "ace.jsonl"), "utf8");
      expect(saved).not.toContain(secret);
      expect(saved).not.toContain("opaque-env");
      expect(saved).not.toContain("/private/home");
      expect(saved).toContain("<WORKSPACE>/file");
      expect(saved).toContain("inputTokens");
      expect(saved).toContain("12");
      expect(saved).toContain("INVALID STRUCTURED DATA OMITTED");
      const rows: unknown[] = saved
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[0]).toMatchObject({ data: { stderr: expect.stringContaining('"code":7') } });
    } finally {
      await sink.close();
    }
  },
);
