// SPDX-License-Identifier: Apache-2.0
/**
 * The addon surface the native streams shells drive, and its loader. Loaded once
 * per process, only after the owning module asked `supervisorBackend()`.
 */

import { supervisorAddon } from "./native-process.ts";

/** A JavaScript string or number as the JSON-RPC ids accept them. */
export type RpcIdValue = string | number;

/** Lines from one crossing, joined by LF; `count` tells zero lines from one empty. */
export interface FramedLines {
  text: string;
  count: number;
}

/** One `DroppedOutputLine` as the addon reports it. */
export interface NativeDroppedLine {
  bytes: number;
  prefix: string;
  phase: "start" | "end" | "complete";
}

export interface NativeFramedPart {
  kind: "data" | "drop";
  data?: Uint8Array | null;
  line?: NativeDroppedLine | null;
}

export interface NativeNoteStep {
  note?: string | null;
  arm: boolean;
}

export interface NativeSseEvent {
  data: string;
  event: string;
  /** Absent when it repeats the previous event's id, which the parser holds. */
  id?: string | null;
  retryMs?: number | null;
}

interface NativeLineFramer {
  push(chunk: Uint8Array): FramedLines;
  finish(): FramedLines;
}

interface NativeWriterQueue {
  enqueue(bytes: number): number;
  claim(): number | null | undefined;
  written(ticket: number): void;
  cancel(ticket: number): boolean;
  setBlocked(blocked: boolean): void;
  active(): number | null | undefined;
  close(): number[];
}

/** The streams surface of the addon `ace-daemon-node/src/streams.rs` declares. */
export interface StreamsAddon {
  LineFramerNative: new (maxBytes: number) => NativeLineFramer;
  lineRestore(text: string): string;
  streamByteLimit(value: number, name: string): number;
  OutputGateNative: new (maxLineBytes: number | undefined) => {
    push(chunk: Uint8Array): string | null | undefined;
  };
  DroppingGateNative: new (limit: number) => {
    push(chunk: Uint8Array): NativeFramedPart[];
    finish(): NativeFramedPart[];
    stop(): void;
  };
  DroppedNotesNative: new () => {
    dropped(bytes: number, phase: string): NativeNoteStep;
    fire(): NativeNoteStep;
    flush(): string | null | undefined;
  };
  JsonLinesNative: new (maxBytes: number) => {
    push(chunk: Uint8Array): { lines: FramedLines; error?: string | null };
    finish(paused: boolean): string | null | undefined;
  };
  SseParserNative: new (
    maxLineBytes: number,
    maxEventBytes: number,
    lastEventId: string,
  ) => {
    feed(text: string): { events: NativeSseEvent[]; error?: string | null };
    lastEventId(): string;
    retryMs(): number | null | undefined;
  };
  RpcIdsNative: new (maxExplicit: number) => {
    reserve(explicitJson?: string): string;
  };
  WriterQueueNative: new (maxQueuedBytes: number) => NativeWriterQueue;
  rpcInspect(line: string): "unparsable" | "malformed" | "request" | "notification" | "response";
  rpcErrorCode(message: string): number | null | undefined;
  ReaderFlowNative: new () => {
    beginDrain(): boolean;
    endDrain(): void;
    block(): void;
    unblock(): void;
    fail(): void;
    detach(): void;
  };
}

/** The addon: the native supervisor build this tree made. */
export function streams(): StreamsAddon {
  // Trusted: the addon this tree built, with the exports `streams.rs` declares.
  return supervisorAddon() as unknown as StreamsAddon;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The shield `line-reader.ts` uses; native protection writes it before a digit. */
export const SHIELD = "\uFDD0";

/** The protected line as the process wrote it. */
export function restoreLine(line: string): string {
  return line.includes(SHIELD) ? streams().lineRestore(line) : line;
}
