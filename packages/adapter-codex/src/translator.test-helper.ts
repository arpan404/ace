import { replayHarness } from "./replay.test-helper.ts";
export function setup() {
  const h = replayHarness();
  let seq = 0;
  const recv = (method: string, params: unknown, id?: number) =>
    h.feed({
      seq: seq++,
      t: seq,
      dir: "recv",
      channel: "stdio",
      data: { method, params, ...(id === undefined ? {} : { id }) },
    });
  const send = (method: string, params: unknown, id = 90) =>
    h.feed({ seq: seq++, t: seq, dir: "send", channel: "stdio", data: { id, method, params } });
  const start = (threadId = "native", id = "turn") =>
    recv("turn/started", { threadId, turn: { id } });
  const end = (status = "completed", threadId = "native", id = "turn") =>
    recv("turn/completed", { threadId, turn: { id, status } });
  const item = (data: unknown, complete = false, threadId = "native", turnId = "turn") =>
    recv(complete ? "item/completed" : "item/started", { threadId, turnId, item: data });
  recv("thread/started", { thread: { id: "native", cwd: "/repo" } });
  return { ...h, recv, send, start, end, item };
}
export const shell = {
  id: "exec",
  type: "commandExecution",
  command: "loop",
  status: "inProgress",
  commandActions: [],
};
