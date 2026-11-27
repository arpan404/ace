// SPDX-License-Identifier: Apache-2.0
//! The MCP server's fixed numbers (docs/mcp-server/behaviour.md §3, porting-guide.md rule 5).
//!
//! Every limit here is today's TypeScript, computed from the protocol's own constants where it
//! derives from them. `MAX_REQUEST_BODY_BYTES` is the largest body the endpoint admits; each tool
//! still enforces its own input budget after parsing.

/// Validated result JSON, transport envelope excluded (`result-budgets.ts:4`).
pub const MAX_STRUCTURED_RESULT_BYTES: usize = 256 * 1024;
/// Rich content results, images included (`result-budgets.ts:5`).
pub const MAX_RICH_RESULT_BYTES: usize = 12 * 1024 * 1024;
/// The largest image a model is shown (`result-budgets.ts:6`).
pub const MAX_MODEL_IMAGE_BYTES: usize = 1024 * 1024;
/// A stdio bridge reply (`result-budgets.ts:7`).
pub const MAX_BRIDGE_RESPONSE_BYTES: usize = MAX_RICH_RESULT_BYTES + 64 * 1024;
/// Replies queued in the bridge (`result-budgets.ts:8`).
pub const MAX_BRIDGE_QUEUED_BYTES: usize = 32 * 1024 * 1024;
/// `maxMessageBytes` (256 KiB) plus a call's other fields (`result-budgets.ts:10`).
pub const MAX_CONTROL_INPUT_BYTES: usize = 256 * 1024 + 64 * 1024;
/// `delegate` starts up to eight children in one call (`result-budgets.ts:12`).
pub const MAX_BATCH_INPUT_BYTES: usize = 8 * MAX_CONTROL_INPUT_BYTES;
/// `maxHtmlDocumentBytes` (16 MiB) plus room for escape-heavy markup (`result-budgets.ts:14`).
pub const MAX_HTML_INPUT_BYTES: usize = 16 * 1024 * 1024 + 4 * 1024 * 1024;
/// `maxSharedImageDataBytes` (16 MiB) as base64 characters, padding included
/// (`protocol/src/image-share.ts:12`).
pub const MAX_SHARED_IMAGE_DATA_CHARS: usize = ((16 * 1024 * 1024) as usize).div_ceil(3) * 4;
/// `image_show`'s base64 image plus its other fields (`result-budgets.ts:16`).
pub const MAX_IMAGE_INPUT_BYTES: usize = MAX_SHARED_IMAGE_DATA_CHARS + 16 * 1024;
/// The largest tool call the HTTP endpoint and the stdio bridge admit (`result-budgets.ts:21`).
pub const MAX_REQUEST_BODY_BYTES: usize = 22_451_544;
/// One tool call's deadline ceiling (`timeouts.ts:2`).
pub const MAX_TOOL_TIMEOUT_MS: u64 = 660_000;
/// Input a tool accepts unless it declares more (`registry.ts:265`).
pub const DEFAULT_MAX_INPUT_BYTES: usize = 64 * 1024;
/// The JSON walk's bounds (`json-budget.ts:5`).
pub const MAX_JSON_NODES: usize = 32_768;
pub const MAX_JSON_DEPTH: usize = 64;
/// Live leases (`credentials.ts:33`).
pub const MAX_LEASES: usize = 1024;
/// A lease's longest lifetime: 24 hours (`credentials.ts:34`).
pub const MAX_CREDENTIAL_AGE_MS: u64 = 24 * 60 * 60 * 1000;
/// Tools one registry holds (`registry.ts:242`).
pub const MAX_TOOLS: usize = 128;
/// Calls running in all, and per thread (`registry.ts:245`–`:246`).
pub const MAX_CALLS: usize = 1024;
pub const MAX_CALLS_PER_THREAD: usize = 256;
/// Concurrent HTTP requests (`http.ts:194`).
pub const MAX_REQUESTS: usize = 2048;
/// A request's header block (`http.ts:255`).
pub const MAX_HEADER_BYTES: usize = 8_192;
/// The listener's timeouts (`http.ts:255`).
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const HEADERS_TIMEOUT_MS: u64 = 10_000;
/// Listen streams one lease keeps; a newer one closes its oldest (`principal-bus.ts:6`).
pub const LISTEN_STREAMS_PER_LEASE: usize = 2;
/// Notification streams in all, per kind (`http.ts:93`).
pub const NOTIFICATION_STREAMS_TOTAL: usize = 512;
/// Legacy transport sessions one lease keeps (`legacy-sessions.ts:20`).
pub const LEGACY_SESSIONS_PER_LEASE: usize = 4;
/// How often a long call reports progress (`progress-heartbeat.ts:4`).
pub const PROGRESS_INTERVAL_MS: u64 = 30_000;
/// A client's shortest and longest call budget (`toolsets.ts:65`).
pub const MIN_CALL_BUDGET_SECONDS: u64 = 5;
pub const MAX_CALL_BUDGET_SECONDS: u64 = 600;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_bound_is_the_largest_input_plus_transport_grace() {
        assert_eq!(MAX_REQUEST_BODY_BYTES, 22_451_544);
        const _: () = {
            assert!(MAX_REQUEST_BODY_BYTES > MAX_IMAGE_INPUT_BYTES);
            assert!(MAX_REQUEST_BODY_BYTES > MAX_HTML_INPUT_BYTES);
            assert!(MAX_REQUEST_BODY_BYTES > MAX_BATCH_INPUT_BYTES);
            assert!(MAX_REQUEST_BODY_BYTES == MAX_IMAGE_INPUT_BYTES + 64 * 1024);
        };
    }

    #[test]
    fn the_control_batches_match_the_protocols_message_size() {
        assert_eq!(MAX_CONTROL_INPUT_BYTES, 320 * 1024);
        assert_eq!(MAX_BATCH_INPUT_BYTES, 2_621_440);
        assert_eq!(MAX_SHARED_IMAGE_DATA_CHARS, 22_369_624);
    }
}
