import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelInstance, type Deadline } from "../types.ts";

export function instance(
  provider: ModelInstance["provider"] = "codex",
  id: string = provider,
): ModelInstance {
  return ModelInstance.parse({
    id,
    provider,
    loginRevision: "account-1",
    executable: process.execPath,
    cwd: process.cwd(),
  });
}
export function codexPayload(model = "coder", isDefault = true) {
  return {
    data: [
      {
        id: `catalog-${model}`,
        model,
        displayName: model.toUpperCase(),
        isDefault,
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low" },
          { reasoningEffort: "high", description: "High" },
        ],
        defaultReasoningEffort: "high",
        inputModalities: ["text", "image"],
        contextWindow: 200000,
        serviceTiers: [{ id: "priority", name: "Fast", description: "Fast tier" }],
        defaultServiceTier: "priority",
      },
    ],
    nextCursor: null,
  };
}
function uninitialized(): never {
  throw new Error("Uninitialized deferred");
}
export function deferred<T>() {
  let resolve: (value: T) => void = uninitialized;
  let reject: (error: unknown) => void = uninitialized;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export class Clock {
  now = 1000;
  readonly timers = new Set<() => void>();
  deadline: Deadline = (expire) => {
    this.timers.add(expire);
    return () => {
      this.timers.delete(expire);
    };
  };
  expire() {
    for (const expire of this.timers) expire();
  }
}
export async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "ace-models-"));
  return { path, close: () => rm(path, { recursive: true, force: true }) };
}
export async function fakeCli(path: string): Promise<string> {
  const script = join(path, "fake-cli.mjs");
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_PROVIDER;
const payload = JSON.parse(process.env.FAKE_PAYLOAD ?? '{}');
if (mode === 'opencode' && process.argv.includes('auth')) {
  console.log(process.env.FAKE_CONNECTIONS ?? JSON.stringify([{id:'local',connections:[{type:'env'}]}]));
} else if (mode === 'opencode' && process.argv.includes('--version')) {
  console.log('opencode v2.0.22');
} else if (mode === 'opencode' && process.argv.includes('models')) {
  console.log(process.env.FAKE_MODEL_IDS ?? '');
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(5 * 1024 * 1024));
} else {
  if (mode === 'hang') console.log('ready');
  createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (mode === 'hang') return;
    if (mode === 'claude') {
      if (request.type !== 'control_request' || request.request?.subtype !== 'initialize') process.exit(9);
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:payload}}));
      return;
    }
    if (!['initialize','initialized','model/list','session/new','cursor/list_available_models'].includes(request.method)) process.exit(9);
    if (request.method === 'initialized') return;
    if (request.method === 'cursor/list_available_models') {
      if (process.env.FAKE_CURSOR_MODELS) console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:JSON.parse(process.env.FAKE_CURSOR_MODELS)}));
      else console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unsupported'}}));
      return;
    }
    let result;
    if (request.method === 'initialize') result = mode === 'codex' ? {} : {protocolVersion:1};
    if (request.method === 'model/list') {
      if (!request.params.includeHidden || request.params.limit !== 100) process.exit(8);
      result = Array.isArray(payload) ? payload[request.params.cursor ? 1 : 0] : payload;
    }
    if (request.method === 'model/list' && process.env.FAKE_LARGE === '1') result = { ...payload, data: payload.data.map(model => ({ ...model, huge:'x'.repeat(5*1024*1024) })) };
    if (request.method === 'session/new') {
      if (request.params.mcpServers.length || !request.params.cwd) process.exit(8);
      result = payload;
    }
    const reply = () => console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
    if (request.method === 'model/list' && process.env.FAKE_STDERR === '1')
      process.stderr.write('x'.repeat(5 * 1024 * 1024), reply);
    else reply();
  });
}
`,
  );
  return script;
}
