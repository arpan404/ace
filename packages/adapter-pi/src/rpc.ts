import type { RawSupervisedProcess } from "@ace/provider-kit/process";
import { readJsonLines, RpcWriter } from "@ace/provider-kit/jsonl";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Response } from "./native.ts";
export type Schedule = (callback: () => void, ms: number) => () => void;
/** Pi's correlated command protocol is JSONL, not JSON-RPC. */
export class PiRpc {
  private writer: RpcWriter;
  private pending = new Map<
    string,
    {
      command: string;
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      cancel: () => void;
    }
  >();
  private seq = 0;
  private closed = false;
  private waitingOnHuman = false;
  private detach: () => void;
  private schedule: Schedule;
  private frame: (dir: "send" | "recv", payload: ProviderPayload) => void;
  private fail: (error: Error) => void;
  private redact: (line: string) => string;
  constructor(
    proc: RawSupervisedProcess,
    schedule: Schedule,
    frame: (dir: "send" | "recv", payload: ProviderPayload) => void,
    fail: (error: Error) => void,
    redact: (line: string) => string,
    flow?: import("@ace/provider-kit/flow-control").OutputFlow,
  ) {
    this.schedule = schedule;
    this.frame = frame;
    this.fail = fail;
    this.redact = redact;
    this.writer = new RpcWriter(proc.stdin, 2 * 1024 * 1024);
    this.detach = readJsonLines(
      proc.stdout,
      1024 * 1024,
      (line) => {
        if (this.closed) return;
        try {
          const payload = new ProviderPayload(this.redact(line));
          this.frame("recv", payload);
          const response = Response.safeParse(payload.data);
          if (!response.success) return;
          const r = response.data,
            p = this.pending.get(r.id);
          if (!p) return;
          this.pending.delete(r.id);
          p.cancel();
          if (r.command !== p.command) p.reject(new Error("Pi response command mismatch"));
          else if (!r.success) p.reject(new Error(r.error ?? "Pi command rejected"));
          else p.resolve(r.data);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("Invalid Pi frame"));
        }
      },
      this.fail,
      flow,
    );
  }
  write(data: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Pi RPC closed"));
    const line = JSON.stringify(data);
    if (Buffer.byteLength(line) > 1024 * 1024)
      return Promise.reject(new Error("Pi command exceeds frame limit"));
    const payload = new ProviderPayload(this.redact(line));
    return this.writer
      .send(line + "\n", Buffer.byteLength(line) + 1)
      .then(() => this.frame("send", payload));
  }
  request(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Pi RPC closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Pi command capacity exceeded"));
    const id = `ace-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject, cancel: () => {} });
      if (!this.waitingOnHuman) this.armDeadline(id);
      void this.write({ type: command, ...params, id }).catch((error: unknown) => {
        this.pending.get(id)?.cancel();
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  pauseDeadlines(): void {
    this.waitingOnHuman = true;
    for (const pending of this.pending.values()) pending.cancel();
  }
  resumeDeadlines(): void {
    if (!this.waitingOnHuman || this.closed) return;
    this.waitingOnHuman = false;
    for (const id of this.pending.keys()) this.armDeadline(id);
  }
  private armDeadline(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.cancel = this.schedule(() => {
      this.pending.delete(id);
      pending.reject(new Error("Pi command timed out; execution uncertain"));
      this.fail(new Error("Pi command timed out"));
    }, 30_000);
  }
  close(error = new Error("Pi RPC closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.writer.close(error);
    for (const p of this.pending.values()) {
      p.cancel();
      p.reject(error);
    }
    this.pending.clear();
  }
}
