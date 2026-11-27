// SPDX-License-Identifier: Apache-2.0
/** The native streams shell entry (E2b): framing and I/O here, protocol state in
 * `ace-supervisor`. Split by responsibility; importers use this module. */
export {
  nativeByteLimit,
  nativeDroppedLineNotes,
  nativeDroppingOutputGate,
  nativeLineReader,
  nativeOutputGate,
  nativeReadJsonLines,
} from "./native-framing.ts";
export { NativeSseParser } from "./native-sse.ts";
export { NativeRpcIds, NativeRpcWriter, nativeInspect, nativeRpcErrorCode } from "./native-rpc.ts";
