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
  if (message.method === "textDocument/definition") {
    const document = message.params && message.params.textDocument;
    if (document && typeof document.uri === "string") {
      const targetUri = new URL("../types/example.ts", document.uri).toString();
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: [
          {
            targetUri,
            targetRange: {
              start: { line: 2, character: 2 },
              end: { line: 2, character: 18 }
            },
            targetSelectionRange: {
              start: { line: 2, character: 6 },
              end: { line: 2, character: 17 }
            }
          }
        ]
      });
    }
    return;
  }
  if (message.method === "textDocument/references") {
    const document = message.params && message.params.textDocument;
    if (document && typeof document.uri === "string") {
      const targetUri = new URL("../types/example.ts", document.uri).toString();
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: [
          {
            uri: document.uri,
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 13 }
            }
          },
          {
            uri: targetUri,
            range: {
              start: { line: 2, character: 6 },
              end: { line: 2, character: 17 }
            }
          }
        ]
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

const FAKE_LSP_SERVER_WITH_CONFIGURATION_REQUEST_SOURCE = `
let pendingInitializeId = null;
let pendingConfigurationRequestId = null;
let buffer = Buffer.alloc(0);

function write(packet) {
  const body = Buffer.from(JSON.stringify(packet), "utf8");
  const header = Buffer.from("Content-Length: " + String(body.byteLength) + "\\r\\n\\r\\n", "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

function publishDiagnostics(uri, text) {
  const column = String(text).indexOf("ERROR");
  const diagnostics = column >= 0
    ? [
        {
          range: {
            start: { line: 0, character: column },
            end: { line: 0, character: column + 5 }
          },
          severity: 1,
          message: "Found ERROR marker"
        }
      ]
    : [];
  write({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics }
  });
}

function handleMessage(message) {
  if (typeof message.method === "string" && message.method === "initialize") {
    pendingInitializeId = message.id;
    pendingConfigurationRequestId = 9001;
    write({
      jsonrpc: "2.0",
      id: pendingConfigurationRequestId,
      method: "workspace/configuration",
      params: {
        items: [{ section: "typescript.preferences" }]
      }
    });
    return;
  }
  if (typeof message.id === "number" && message.id === pendingConfigurationRequestId) {
    write({ jsonrpc: "2.0", id: pendingInitializeId, result: { capabilities: {} } });
    pendingConfigurationRequestId = null;
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
      publishDiagnostics(document.uri, document.text || "");
    }
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
          const definition = yield* workspaceEditor.definition({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
            contents:
              'import { ExampleType } from "../types/example";\nconst value: ExampleType = createValue();\n',
            line: 1,
            column: 13,
          });
          const references = yield* workspaceEditor.references({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
            contents:
              'import { ExampleType } from "../types/example";\nconst value: ExampleType = createValue();\n',
            line: 1,
            column: 13,
          });
          const closed = yield* workspaceEditor.closeBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
          });
          return { clean, broken, definition, references, closed };
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
      expect(result.definition).toEqual({
        relativePath: "src/example.ts",
        locations: [
          {
            relativePath: "types/example.ts",
            startLine: 2,
            startColumn: 6,
            endLine: 2,
            endColumn: 17,
          },
        ],
      });
      expect(result.references).toEqual({
        relativePath: "src/example.ts",
        locations: [
          {
            relativePath: "src/example.ts",
            startLine: 0,
            startColumn: 6,
            endLine: 0,
            endColumn: 13,
          },
          {
            relativePath: "types/example.ts",
            startLine: 2,
            startColumn: 6,
            endLine: 2,
            endColumn: 17,
          },
        ],
      });
      expect(result.closed).toEqual({
        relativePath: "src/example.ts",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("responds to server requests while initializing the LSP session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceEditor = yield* WorkspaceEditor;
      const workspaceDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ace-workspace-editor-init-request-",
      });
      const serverScriptPath = path.join(workspaceDir, "fake-lsp-config-request.cjs");
      yield* fileSystem.writeFileString(
        serverScriptPath,
        FAKE_LSP_SERVER_WITH_CONFIGURATION_REQUEST_SOURCE,
      );

      const result = yield* withLspEnv(
        serverScriptPath,
        workspaceEditor.syncBuffer({
          cwd: workspaceDir,
          relativePath: "src/example.ts",
          contents: "ERROR();\n",
        }),
      );

      expect(result).toEqual({
        diagnostics: [
          {
            endColumn: 5,
            endLine: 0,
            message: "Found ERROR marker",
            severity: "error",
            source: "lsp",
            startColumn: 0,
            startLine: 0,
          },
        ],
        relativePath: "src/example.ts",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
