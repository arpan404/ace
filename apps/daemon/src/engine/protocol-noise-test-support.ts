import type { Frame, ProviderAdapter } from "@ace/engine-api";
import type { ProviderKind } from "@ace/protocol";
import { createTranslator } from "@ace/adapter-claude";
import { createCodexTranslator } from "@ace/adapter-codex";
import { CursorTranslator } from "@ace/adapter-cursor";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { createPiTranslator } from "@ace/adapter-pi";
import {
  createAcpTranslator,
  antigravityQuirks,
  cursorQuirks,
  genericQuirks,
} from "@ace/adapter-acp";

type Input = Pick<Frame, "data" | "channel" | "dir">;
const recv = (data: unknown, channel = "stdio"): Input => ({ data, channel, dir: "recv" });
const send = (data: unknown): Input => ({ data, channel: "stdio", dir: "send" });
const names = ["future/extension", "future.event", "9b37761f-8360-4f84-9cd7-334659d77087"];
const evidence = {
  opaque: { survives: "future evidence", api_key: "synthetic-secret", large: "x".repeat(10000) },
};
const sdk = (kind: string, body: unknown) =>
  recv({ schemaVersion: 1, generation: "host", operationId: "op", segment: 0, kind, body }, "sdk");
export const protocolNoiseCases: {
  name: string;
  provider: ProviderKind;
  create: ProviderAdapter["createTranslator"];
  setup: Input[];
  noise: Input[];
  after: Input[];
}[] = [
  {
    name: "Claude",
    provider: "claude",
    create: createTranslator,
    setup: [
      recv({ type: "system", subtype: "init", session_id: "native", cwd: "/fixture" }, "sdk"),
    ],
    noise: [
      recv({ type: "keep_alive" }, "sdk"),
      recv({ type: "control_response", response: { subtype: "success" } }, "sdk"),
      ...names.map((type) => recv({ type, ...evidence }, "sdk")),
    ],
    after: [
      recv(
        {
          type: "assistant",
          message: { id: "m", content: [{ type: "text", text: "Still here" }] },
        },
        "sdk",
      ),
    ],
  },
  {
    name: "Codex",
    provider: "codex",
    create: createCodexTranslator,
    setup: [
      recv({ method: "thread/started", params: { thread: { id: "native", cwd: "/fixture" } } }),
    ],
    noise: [
      send({ id: 1, method: "initialize", params: {} }),
      recv({ id: 1, result: {} }),
      ...names.map((method) => recv({ method, params: { threadId: "native", ...evidence } })),
    ],
    after: [
      recv({
        method: "item/completed",
        params: { threadId: "native", item: { id: "m", type: "agentMessage", text: "Still here" } },
      }),
    ],
  },
  {
    name: "Cursor SDK",
    provider: "cursor",
    create: (init) => new CursorTranslator(init),
    setup: [
      sdk("open", { cwd: "/fixture" }),
      sdk("send", { input: [{ type: "text", text: "Input" }] }),
    ],
    noise: [
      sdk("observe", {}),
      sdk("message", { type: "status" }),
      ...names.flatMap((type) => [
        sdk("delta", { type, ...evidence }),
        sdk("message", { type, ...evidence }),
        sdk(type, evidence),
      ]),
    ],
    after: [sdk("delta", { type: "text-delta", text: "Still here" })],
  },
  {
    name: "OpenCode",
    provider: "opencode",
    create: (init) => new OpenCodeTranslator(init),
    setup: [
      recv(
        {
          id: "created",
          type: "session.created",
          data: { id: "native", projectID: "project", location: { directory: "/fixture" } },
        },
        "sse",
      ),
    ],
    noise: [
      recv({ method: "GET", path: "/api/session", status: 200, body: {} }, "http"),
      ...names.map((type, i) =>
        recv({ id: `event-${i}`, type, data: { sessionID: "native", ...evidence } }, "sse"),
      ),
    ],
    after: [
      recv(
        {
          id: "text",
          type: "session.text.ended",
          data: { sessionID: "native", assistantMessageID: "m", ordinal: 0, text: "Still here" },
        },
        "sse",
      ),
    ],
  },
  {
    name: "Pi",
    provider: "pi",
    create: createPiTranslator,
    setup: [recv({ type: "agent_start" })],
    noise: [
      recv({ type: "response", success: true }),
      recv({ type: "entry_appended" }),
      recv({ type: "compaction_end" }),
      recv({
        type: "extension_ui_request",
        id: "status",
        method: "setStatus",
        statusText: "future.event",
      }),
      recv({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "future_block" }] },
      }),
      ...names.map((type) => recv({ type, ...evidence })),
      recv(null),
    ],
    after: [
      recv({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Still here" }] },
      }),
    ],
  },
  ...[genericQuirks, cursorQuirks, antigravityQuirks].map((quirks) => ({
    name: `ACP ${quirks.provider}`,
    provider: quirks.provider,
    create: (init: Parameters<ProviderAdapter["createTranslator"]>[0]) =>
      createAcpTranslator({ ...init, identity: { generation: "test", cursor: 0 } }, quirks),
    setup: [
      send({ id: 1, method: "session/new", params: { cwd: "/fixture" } }),
      recv({ id: 1, result: { sessionId: "native" } }),
    ],
    noise: [
      recv({ id: 99, result: {} }),
      recv({
        method: "session/update",
        params: {
          sessionId: "native",
          update: { sessionUpdate: "current_mode_update", modeId: "default" },
        },
      }),
      ...names.map((method) => recv({ method, params: evidence })),
      recv(null),
    ],
    after: [
      recv({
        method: "session/update",
        params: {
          sessionId: "native",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Still here" },
          },
        },
      }),
    ],
  })),
];
