import type { Frame } from "@ace/engine-api";

/** Certificates own immutable admitted JSON; cloning them discards their private proof. */
export function copyScriptedFrame(frame: Frame): Frame {
  const { payload, data, ...metadata } = frame;
  return {
    ...structuredClone(metadata),
    data: payload && payload.data === data ? data : structuredClone(data),
    ...(payload ? { payload } : {}),
  };
}
