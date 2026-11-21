// SPDX-License-Identifier: Apache-2.0
//! The image process (ADR 0201): one-shot image jobs in a process of their own
//! (`ace-media --images`), apart from live video and recordings, and the same work one job at a
//! time for tests and tools (`ace-media --image`).
pub mod budget;
pub mod files;
pub mod jobs;
pub mod output;
pub mod pool;
pub mod server;
