// SPDX-License-Identifier: Apache-2.0
//! Subscriptions and fan-out in Rust (ADR 0226 T3): what one connection receives, byte for
//! byte as the TypeScript transport sends it.
//!
//! - [`encode`] is `WireEncoder`: an events message split into 1 MiB frames and written with
//!   the exact envelope the TypeScript writes.
//! - [`event`] is `EventEncodings` and the short-delta frame: each event's JSON made once,
//!   with its trimmed form for a connection that asked for one.
//! - [`raw_trim`] is `rawShownOnly`/`omitRaw`: the item events whose raw payloads a client
//!   only shows.

pub mod command_lanes;
pub mod command_status;
pub mod encode;
pub mod event;
mod js;
pub mod older_status;
pub mod publication;
pub mod raw_trim;
pub mod read;
pub mod sidebar;
pub mod subscription;
pub mod wire_trim;

pub use command_lanes::{CommandLanes, LaneRun, command_lane, settled_within};
pub use command_status::{CommandState, CommandStatusState, command_state};
pub use encode::{EVENT_FRAME_BYTES, EventShape, EventsMessage, WHOLE_EVENTS, WireEncoder};
pub use event::{DeliveryEvent, EventEncodings, short_delta_json};
pub use older_status::{older_status, older_statuses};
pub use publication::{ListenerId, Publication};
pub use raw_trim::{
    ProviderNotice, diagnostic_notice_text, history_message_identity, is_diagnostic_notice,
    is_provider_retry_notice, is_raw_history_item, omit_raw, provider_notice, raw_shown_only,
};
pub use read::{
    CoreReader, CoreStore, FailScope, MAX_SUBSCRIPTIONS, ManagedSubscription, OUTPUT_READ_BYTES,
    PAGE_REPLY_BYTES, PageFn, ReadError, SubscribeFn, Subscriptions, read_core,
};
pub use sidebar::{
    DeviceReads, PageReuse, PlacedStanding, Placement, SidebarError, SidebarPage, SidebarStore,
    SidebarSubscription, SidebarWindow, ThreadListCursor, ThreadListResume,
};
pub use subscription::{
    DEFAULT_PROGRESS_INTERVAL_MS, DEFAULT_REPLAY_LIMIT, REPLAY_COMPARE_BYTES, REPLAY_FRAME_BYTES,
    REPLAY_READ_BYTES, Scope, SnapshotTail, SubscribeError, SubscribeOptions, Subscription,
    SubscriptionFrame, SubscriptionStore,
};
pub use wire_trim::{
    SUPPORTED_TRIMS, WireRestorer, WireTrimmer, restore_thread_list, share_thread_list, trim_item,
};
