#!/usr/bin/env node
// Local boundary double. It never executes model prompts or provider tools.
import { createServer } from "node:http";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`opencode v${process.env.ACE_TEST_OPENCODE_VERSION ?? "2.0.22"}`);
  process.exit(0);
}
if (args[0] === "auth") {
  // Credential-free `auth list` shape. The served models' upstream is connected by default.
  console.log(
    process.env.ACE_TEST_OPENCODE_CONNECTIONS ??
      JSON.stringify([{ id: "opencode-go", connections: [{ type: "credential" }] }]),
  );
  process.exit(0);
}
if (args[0] === "models") {
  if (args.length !== 1) process.exit(7);
  console.log("opencode-go/muse-spark-1.3-contributor");
  process.exit(0);
}
if (args[0] !== "serve") process.exit(1);
if (!args.includes("--stdio") || !process.env.OPENCODE_PASSWORD) process.exit(2);
const streams = new Set(),
  requests = [],
  sessions = new Map(),
  messages = new Map(),
  inbox = new Map();
let permissions = [],
  forms = [],
  shells = [],
  active = {},
  serial = 0,
  eventID = 0,
  connections = 0;
let fault = {},
  beforeRead,
  held,
  heldPrompt;
const operations = [
  "server.info",
  "event.subscribe",
  "session.create",
  "session.get",
  "session.switchModel",
  "session.list",
  "session.active",
  "session.prompt",
  "session.interrupt",
  "session.message.list",
  "session.permission.list",
  "session.permission.reply",
  "session.form.list",
  "session.form.reply",
  "session.form.cancel",
  "session.inbox.list",
  "shell.list",
  "shell.get",
  "shell.remove",
  "model.list",
  "model.default",
  "command.list",
];
const publish = (type, data, directory = "/one", extra = {}) => {
  const e = {
    id: `event-${++eventID}`,
    created: eventID,
    type,
    data,
    location: { directory },
    ...extra,
  };
  for (const stream of streams) stream.write(`data: ${JSON.stringify(e)}\n\n`);
  return e;
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    path = url.pathname;
  if (
    req.headers.authorization !==
    `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
  ) {
    res.writeHead(401).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const json = (data) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const empty = () => res.writeHead(204).end();
  if (path === "/test/mcp") {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const ace = config.mcp?.ace;
    if (!ace) {
      json({ missing: true });
      return;
    }
    const response = await fetch(ace.url, {
      method: "POST",
      headers: {
        ...ace.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "ace_scope",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ace_scope",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "synthetic-opencode", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    json({
      names: Object.keys(config.mcp),
      status: response.status,
      response: response.ok ? await response.json() : null,
    });
    return;
  }
  requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });
  if (path === "/api/info") {
    if (process.env.ACE_TEST_HTML === "1") {
      res.writeHead(200, { "content-type": "text/html" }).end("<html>secret</html>");
      return;
    }
    json({ version: process.env.ACE_TEST_SERVER_VERSION ?? "2.0.22", pid: process.pid });
    return;
  }
  if (path === "/openapi.json") {
    json({
      openapi: "3.1.0",
      paths: Object.fromEntries(
        operations
          .filter((op) => op !== process.env.ACE_TEST_MISSING_OPERATION)
          .map((operationId, i) => [`/api/${i}`, { get: { operationId } }]),
      ),
    });
    return;
  }
  if (path === "/api/event") {
    connections++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: `connected-${connections}`, type: "server.connected", data: {} })}\n\n`,
    );
    streams.add(res);
    res.on("close", () => streams.delete(res));
    return;
  }
  if (path === "/test/events") {
    for (const event of body) {
      if (event.raw) for (const stream of streams) stream.write(event.raw);
      else publish(event.type, event.data, event.directory ?? "/one", event.extra ?? {});
    }
    json(true);
    return;
  }
  if (path === "/test/drop") {
    for (const stream of streams) stream.end();
    json(true);
    return;
  }
  if (path === "/test/state") {
    if (body.sessions) for (const info of body.sessions) sessions.set(info.id, info);
    if (body.messages)
      for (const [id, records] of Object.entries(body.messages)) messages.set(id, records);
    if (body.inbox) for (const [id, records] of Object.entries(body.inbox)) inbox.set(id, records);
    if (body.active) active = body.active;
    permissions = body.permissions ?? permissions;
    forms = body.forms ?? forms;
    shells = body.shells ?? shells;
    fault = body.fault ?? fault;
    beforeRead = body.beforeRead ?? beforeRead;
    json(true);
    return;
  }
  if (path === "/test/instance") {
    json({ instance: process.env.ACE_TEST_INSTANCE ?? "default" });
    return;
  }
  if (path === "/test/requests") {
    json(requests);
    return;
  }
  if (path === "/test/connections") {
    json(connections);
    return;
  }
  if (path === "/test/release-prompt") {
    heldPrompt?.();
    heldPrompt = undefined;
    json(true);
    return;
  }
  if (path === "/test/release") {
    held?.();
    held = undefined;
    json(true);
    return;
  }
  if (process.env.ACE_TEST_METADATA_ONLY === "1" && ["/api/session", "/api/auth"].includes(path)) {
    res.writeHead(500).end();
    return;
  }
  if (path === "/api/command" && req.method === "GET") {
    if (process.env.ACE_TEST_COMMANDS_UNAVAILABLE === "1") {
      res.writeHead(404).end();
      return;
    }
    json({
      location: { directory: "/one" },
      data: [{ name: "native-explain", description: "Explain code" }],
    });
    return;
  }
  if (path === "/api/session" && req.method === "POST") {
    const id = `session-${++serial}`,
      info = {
        id,
        projectID: "project-one",
        location: body.location,
        time: { created: 1, updated: 1, idle: 1 },
        transportDebug: process.env.OPENCODE_PASSWORD,
        ...body,
      };
    sessions.set(id, info);
    json({ data: info });
    return;
  }
  if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({
        _tag: "InvalidCursorError",
        message: "Cursor cannot be combined with order",
      }),
    );
    return;
  }
  if (path === "/api/session" && req.method === "GET") {
    const parent = url.searchParams.get("parentID"),
      directory = url.searchParams.get("directory"),
      project = url.searchParams.get("project"),
      limit = Number(url.searchParams.get("limit")),
      start = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0);
    const records = [...sessions.values()].filter(
      (s) => s.parentID === parent && s.location.directory === directory && s.projectID === project,
    );
    json({
      data: records.slice(start, start + limit),
      cursor: { next: start + limit < records.length ? `children:${start + limit}` : null },
    });
    return;
  }
  if (path === "/api/session/active") {
    json({ data: active });
    return;
  }
  if (path === "/api/shell") {
    const directory = url.searchParams.get("location[directory]");
    json({ location: { directory }, data: shells.filter((s) => s.cwd === directory) });
    return;
  }
  if (path === "/api/model/default") {
    json({
      location: { directory: url.searchParams.get("location[directory]") },
      data: {
        providerID: "opencode-go",
        modelID: "muse-spark-1.3-contributor",
        id: "opencode-go/muse-spark-1.3-contributor",
      },
    });
    return;
  }
  if (path === "/api/model") {
    const directory =
      process.env.ACE_TEST_MODEL_LOCATION ?? url.searchParams.get("location[directory]");
    if (process.env.ACE_TEST_EMPTY_MODELS === "true") {
      json({ location: { directory }, data: [] });
      return;
    }
    json({
      location: { directory },
      data: [
        {
          id: "opencode-go/muse-spark-1.3-contributor",
          modelID: "muse-spark-1.3-contributor",
          providerID: "opencode-go",
          name: "Muse Spark",
          enabled: true,
          status: "active",
          variants: [{ id: "high", headers: { authorization: "secret" } }],
          capabilities: { input: { text: true, image: true } },
          limit: { context: 200000, output: 8192 },
          headers: { authorization: "secret" },
          transportDebug: process.env.OPENCODE_PASSWORD,
        },
      ],
    });
    return;
  }
  if (path.startsWith("/api/shell/") && req.method === "GET") {
    const shell = shells.find((s) => s.id === path.split("/")[3]);
    if (shell)
      json({ location: { directory: url.searchParams.get("location[directory]") }, data: shell });
    else
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ message: "Missing shell" }));
    return;
  }
  if (path.startsWith("/api/shell/") && req.method === "DELETE") {
    const id = path.split("/")[3];
    shells = shells.filter((s) => s.id !== id);
    empty();
    return;
  }
  const match = /^\/api\/session\/([^/]+)(.*)$/.exec(path);
  if (match) {
    const [, id, suffix] = match;
    if (suffix === "/model" && req.method === "POST") {
      const info = sessions.get(id);
      if (!info) {
        res.writeHead(404).end();
        return;
      }
      info.model = body.model;
      empty();
      return;
    }
    if (!suffix) {
      const info = sessions.get(id);
      if (!info) {
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ message: "Unknown session" }));
        return;
      }
      if (req.method === "PATCH") {
        Object.assign(info, body);
        res.writeHead(204).end();
        return;
      }
      json({ data: info });
      return;
    }
    if (suffix === "/prompt") {
      if (!body.id?.startsWith("msg_")) {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ message: "Invalid input ID" }));
        return;
      }
      if (fault.promptInvisible) {
        fault.promptInvisible = false;
        res.destroy();
        return;
      }
      const item = {
        id: body.id,
        sessionID: id,
        type: "user",
        payload: body,
        time: { created: 1 },
        delivery: body.delivery,
      };
      inbox.set(id, [...(inbox.get(id) ?? []), item]);
      requests[requests.length - 1].modelUsed = sessions.get(id)?.model;
      publish(
        "session.inbox.enqueued",
        { sessionID: id, inboxID: item.id },
        sessions.get(id)?.location.directory,
      );
      if (process.env.ACE_TEST_COMPLETE_INPUT === "1") {
        const directory = sessions.get(id)?.location.directory;
        inbox.set(id, []);
        publish("session.inbox.delivered", { sessionID: id, inboxID: item.id }, directory);
        publish("session.execution.started", { sessionID: id }, directory);
        publish("session.execution.succeeded", { sessionID: id }, directory);
      }
      if (fault.holdPrompt) {
        fault.holdPrompt = false;
        heldPrompt = () => json({ data: item });
        return;
      }
      if (fault.promptDisconnect) {
        res.destroy();
        fault.promptDisconnect = false;
        return;
      }
      json({ data: item });
      return;
    }
    if (suffix === "/interrupt") {
      if (fault.interruptFailure) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ message: process.env.OPENCODE_PASSWORD }));
        return;
      }
      json({ interrupted: !fault.noopInterrupt });
      return;
    }
    if (suffix === "/inbox") {
      json({ data: inbox.get(id) ?? [] });
      return;
    }
    if (suffix === "/permission") {
      json({ data: permissions.filter((p) => p.sessionID === id) });
      return;
    }
    if (suffix === "/form") {
      json({ data: forms.filter((p) => p.sessionID === id) });
      return;
    }
    if (suffix.startsWith("/permission/") && req.method === "POST") {
      empty();
      return;
    }
    if (suffix.startsWith("/form/") && ["POST", "DELETE"].includes(req.method)) {
      empty();
      return;
    }
    if (suffix.startsWith("/message/")) {
      json({ data: (messages.get(id) ?? []).find((m) => m.id === suffix.slice(9)) });
      return;
    }
    if (suffix === "/message") {
      const reply = () => {
        let records = messages.get(id) ?? [];
        if (url.searchParams.get("order") === "desc") records = records.toReversed();
        const start = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0),
          limit = Number(url.searchParams.get("limit"));
        json({
          data: records.slice(start, start + limit),
          cursor: { next: start + limit < records.length ? `messages:${start + limit}` : null },
        });
      };
      if (beforeRead) {
        const events = beforeRead;
        beforeRead = undefined;
        for (const e of events) publish(e.type, e.data, e.directory);
      }
      if (fault.holdHistory) {
        fault.holdHistory = false;
        held = reply;
      } else reply();
      return;
    }
  }
  res
    .writeHead(404, { "content-type": "application/json" })
    .end(JSON.stringify({ message: "Unimplemented fake route" }));
});
server.listen(0, "127.0.0.1", () => {
  console.error(`password=${process.env.OPENCODE_PASSWORD}`);
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
});
process.stdin.resume();
process.stdin.on("end", () => {
  for (const stream of streams) stream.end();
  server.close();
});
