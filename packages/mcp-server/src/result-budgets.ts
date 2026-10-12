/** Validated result JSON excludes the transport envelope and SSE framing. */
export const maxStructuredResultBytes = 256 * 1024;
export const maxRichResultBytes = 12 * 1024 * 1024;
export const maxModelImageBytes = 1024 * 1024;
export const maxBridgeResponseBytes = maxRichResultBytes + 64 * 1024;
export const maxBridgeQueuedBytes = 32 * 1024 * 1024;
