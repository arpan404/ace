import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import { WorkspaceEditor } from "../Services/WorkspaceEditor.ts";
import { WorkspaceEditorLive } from "./WorkspaceEditor.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const WorkspaceEditorLayer = WorkspaceEditorLive.pipe(Layer.provide(WorkspacePathsLive));

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEditorLayer),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ace-workspace-editor-test" })),
  Layer.provideMerge(NodeServices.layer),
);

const FAKE_LSP_SERVER_SOURCE = `
const diagnosticsByUri = new Map();
let buffer = Buffer.alloc(0);

function write(packet) {
  const body = Buffer.from(JSON.stringify(packet), "utf8");
  const header = Buffer.from("Content-Length: " + String(body.byteLength) + "\\r\\n\\r\\n", "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

function computeDiagnostics(uri, text) {
  const lines = String(text).split("\\n");
  const diagnostics = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const column = line.indexOf("ERROR");
    if (column >= 0) {
      diagnostics.push({
        range: {
          start: { line: index, character: column },
          end: { line: index, character: column + 5 }
        },
        severity: 1,
        code: "TEST001",
        source: "ace-test-lsp",
        message: "Found ERROR marker"
      });
    }
  }
  diagnosticsByUri.set(uri, diagnostics);
  write({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics }
  });
}

function handleMessage(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "shutdown") {
    write({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
    return;
  }
  if (message.method === "textDocument/didOpen") {
    const document = message.params && message.params.textDocument;
    if (document && typeof document.uri === "string") {
      computeDiagnostics(document.uri, document.text || "");
    }
    return;
  }
  if (message.method === "textDocument/didChange") {
    const document = message.params && message.params.textDocument;
    const contentChange = message.params && message.params.contentChanges && message.params.contentChanges[0];
    if (document && typeof document.uri === "string") {
      computeDiagnostics(document.uri, (contentChange && contentChange.text) || "");
    }
    return;
  }
  if (message.method === "textDocument/didClose") {
    const document = message.params && message.params.textDocument;
    if (document && typeof document.uri === "string") {
      diagnosticsByUri.delete(document.uri);
      write({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: document.uri, diagnostics: [] }
      });
    }
    return;
  }
}

function tryReadMessages() {
  while (true) {
    const marker = Buffer.from("\\r\\n\\r\\n", "utf8");
    const headerEnd = buffer.indexOf(marker);
    if (headerEnd < 0) {
      return;
    }
    const headerText = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthLine = headerText
      .split("\\r\\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));
    if (!contentLengthLine) {
      buffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number(contentLengthLine.split(":")[1].trim());
    const bodyStart = headerEnd + marker.length;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    const message = JSON.parse(body);
    handleMessage(message);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryReadMessages();
});
`;

const withLspEnv = <A, E, R>(serverScriptPath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previousBin = process.env.ACE_LSP_TYPESCRIPT_SERVER_BIN;
      const previousArgs = process.env.ACE_LSP_TYPESCRIPT_SERVER_ARGS_JSON;
      process.env.ACE_LSP_TYPESCRIPT_SERVER_BIN = process.execPath;
      process.env.ACE_LSP_TYPESCRIPT_SERVER_ARGS_JSON = JSON.stringify([serverScriptPath]);
      return { previousArgs, previousBin };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous.previousBin === undefined) {
          delete process.env.ACE_LSP_TYPESCRIPT_SERVER_BIN;
        } else {
          process.env.ACE_LSP_TYPESCRIPT_SERVER_BIN = previous.previousBin;
        }
        if (previous.previousArgs === undefined) {
          delete process.env.ACE_LSP_TYPESCRIPT_SERVER_ARGS_JSON;
        } else {
          process.env.ACE_LSP_TYPESCRIPT_SERVER_ARGS_JSON = previous.previousArgs;
        }
      }),
  );

describe("WorkspaceEditorLive", () => {
  it.effect("syncs buffers through stdio LSP and returns diagnostics", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceEditor = yield* WorkspaceEditor;
      const workspaceDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ace-workspace-editor-",
      });
      const serverScriptPath = path.join(workspaceDir, "fake-lsp-server.cjs");
      yield* fileSystem.writeFileString(serverScriptPath, FAKE_LSP_SERVER_SOURCE);

      const result = yield* withLspEnv(
        serverScriptPath,
        Effect.gen(function* () {
          const clean = yield* workspaceEditor.syncBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
            contents: "const ready = true;\n",
          });
          const broken = yield* workspaceEditor.syncBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
            contents: "const ready = true;\nERROR();\n",
          });
          const closed = yield* workspaceEditor.closeBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
          });
          return { clean, broken, closed };
        }),
      );

      expect(result.clean).toEqual({
        diagnostics: [],
        relativePath: "src/example.ts",
      });
      expect(result.broken).toEqual({
        diagnostics: [
          {
            code: "TEST001",
            endColumn: 5,
            endLine: 1,
            message: "Found ERROR marker",
            severity: "error",
            source: "ace-test-lsp",
            startColumn: 0,
            startLine: 1,
          },
        ],
        relativePath: "src/example.ts",
      });
      expect(result.closed).toEqual({
        relativePath: "src/example.ts",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
