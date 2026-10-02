import type { Writable } from "node:stream";
import { RpcIds } from "./rpc-ids.ts";
import { RpcWriter } from "./rpc-writer.ts";

type Owner = { ids: RpcIds; writer: RpcWriter };
// I/O ownership follows the actual pipe, including replacement process facades.
// Weak keys release reservations after the pipe and all its owners are unreachable.
const owners = new WeakMap<Writable, Owner>();

export function rpcOwner(
  stream: Writable,
  limits: { maxExplicitIds?: number; maxQueuedBytes?: number },
): Owner {
  const existing = owners.get(stream);
  if (existing) return existing;
  const owner = {
    ids: new RpcIds(limits.maxExplicitIds ?? 4096),
    writer: new RpcWriter(stream, limits.maxQueuedBytes ?? 32 * 1024 * 1024),
  };
  owners.set(stream, owner);
  return owner;
}
