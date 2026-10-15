import { maxMessageBytes } from "@ace/protocol";

/** Validated result JSON excludes the transport envelope and SSE framing. */
export const maxStructuredResultBytes = 256 * 1024;
export const maxRichResultBytes = 12 * 1024 * 1024;
export const maxModelImageBytes = 1024 * 1024;
export const maxBridgeResponseBytes = maxRichResultBytes + 64 * 1024;
export const maxBridgeQueuedBytes = 32 * 1024 * 1024;
/** One agent-control call: a message as long as a person's, plus the call's other fields. */
export const maxControlInputBytes = maxMessageBytes + 64 * 1024;
/** delegate_task starts up to eight children in one call, each with a message-sized task. */
export const maxBatchInputBytes = 8 * maxControlInputBytes;
/** The largest tool call the HTTP endpoint and the stdio bridge admit. */
export const maxRequestBodyBytes = maxBatchInputBytes + 64 * 1024;
