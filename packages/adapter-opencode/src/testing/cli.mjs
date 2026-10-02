#!/usr/bin/env node
// Boundary double for the user's CLI, never a model or a bundled provider.
import { createServer } from "node:http";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(process.env.ACE_TEST_OPENCODE_VERSION ?? "1.18.33");
  process.exit(0);
}
if (args[0] !== "serve") {
  console.log("No credentials configured");
  process.exit(0);
}
const streams = new Set();
const requests = [];
const sessions = new Map();
const statuses = {};
const messages = {};
let permissions = [];
let questions = [];
let counter = 0;
let connections = 0;
let duringMessage;
let streamHistory = false;
let finishHistory;
let onMessage;
let historyReads = 0;
const readWaiters = [];
let stallAbort = false;
const abortWaiters = [];
let aborted = false;
const emit = (data) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify(data)}\n\n`);
};
const event = (type, properties, directory) =>
  emit({ ...(directory ? { directory } : {}), payload: { type, properties } });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (
    req.headers.authorization !==
      `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` ||
    !process.env.OPENCODE_SERVER_PASSWORD
  ) {
    res.writeHead(401).end();
    return;
  }
  if (path === "/global/event") {
    connections++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`,
    );
    streams.add(res);
    res.on("close", () => streams.delete(res));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  const body = text ? JSON.parse(text) : undefined;
  requests.push({ method: req.method, path, directory: url.searchParams.get("directory"), body });
  const reply = (value) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (path === "/test/events") {
    for (const e of body) emit(e);
    reply(true);
    return;
  }
  if (path === "/test/drop") {
    for (const stream of streams) stream.end();
    reply(true);
    return;
  }
  if (path === "/test/state") {
    if (body.streamHistory) streamHistory = true;
    if (body.onMessage) onMessage = body.onMessage;
    if (body.stallAbort) stallAbort = true;
    if (body.duringMessage) duringMessage = body.duringMessage;
    if (body.statuses) Object.assign(statuses, body.statuses);
    if (body.messages) Object.assign(messages, body.messages);
    if (body.sessions) for (const s of body.sessions) sessions.set(s.id, s);
    if (body.questions) questions = body.questions;
    if (body.permissions) permissions = body.permissions;
    reply(true);
    return;
  }
  if (path === "/test/finish-history") {
    finishHistory?.();
    reply(true);
    return;
  }
  if (path === "/test/history-reads") {
    if (historyReads >= body.count) reply(true);
    else readWaiters.push({ count: body.count, reply });
    return;
  }
  if (path === "/test/abort-entered") {
    if (aborted) reply(true);
    else abortWaiters.push(reply);
    return;
  }
  if (path === "/test/requests") {
    reply({
      requests: requests.filter((r) => !r.path.startsWith("/test/")),
      connections,
      pid: process.pid,
    });
    return;
  }
  if (path === "/global/health") {
    reply({ healthy: true, version: "1.18.33" });
    return;
  }
  if (path === "/mcp") {
    reply({ docs_server: { status: "connected" } });
    return;
  }
  if (path === "/permission") {
    reply(permissions);
    return;
  }
  if (path === "/question") {
    reply(questions);
    return;
  }
  if (path === "/session/status") {
    reply(statuses);
    return;
  }
  if (path === "/session" && req.method === "POST") {
    const id = `ses_${++counter}`;
    const info = {
      id,
      directory: url.searchParams.get("directory"),
      projectID: url.searchParams.get("directory"),
      title: "ace",
    };
    sessions.set(id, info);
    event("session.created", { sessionID: id, info }, info.directory);
    reply(info);
    return;
  }
  const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (match) {
    const [, id, operation] = match;
    if (!operation) {
      reply(sessions.get(id));
      return;
    }
    if (operation === "children") {
      reply([...sessions.values()].filter((s) => s.parentID === id));
      return;
    }
    if (operation === "message") {
      historyReads++;
      if (onMessage) emit(onMessage);
      for (const waiter of readWaiters.splice(0)) {
        if (historyReads >= waiter.count) waiter.reply(true);
        else readWaiters.push(waiter);
      }
      if (duringMessage?.sessionID === id) {
        emit(duringMessage.event);
        messages[id] = duringMessage.messages;
        duringMessage = undefined;
      }
      if (streamHistory) {
        streamHistory = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.write(`[${JSON.stringify(messages[id][0])},`);
        finishHistory = () => res.end(`${JSON.stringify(messages[id][1])}]`);
        return;
      }
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? Infinity);
      reply((messages[id] ?? []).filter((m) => !before || m.info.id < before).slice(-limit));
      return;
    }
    if (operation === "prompt_async") {
      event("message.updated", {
        sessionID: id,
        info: { id: body.messageID, sessionID: id, role: "user" },
      });
      statuses[id] = { type: "busy" };
      event("session.status", { sessionID: id, status: statuses[id] });
      reply(null);
      return;
    }
    if (operation === "abort") {
      aborted = true;
      for (const respond of abortWaiters.splice(0)) respond(true);
      if (stallAbort) return;
      statuses[id] = { type: "idle" };
      event("session.error", { sessionID: id, error: { name: "MessageAbortedError" } });
      event("session.status", { sessionID: id, status: statuses[id] });
      reply(true);
      return;
    }
  }
  if (path.startsWith("/permission/") || path.startsWith("/question/")) {
    reply(true);
    return;
  }
  res.writeHead(404).end();
});
server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () =>
  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`),
);
