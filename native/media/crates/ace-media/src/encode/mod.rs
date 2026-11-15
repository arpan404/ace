// SPDX-License-Identifier: Apache-2.0
//! JPEG sources ace-media encodes itself (E4): private-context screencasts and "Use my Chrome"
//! tabs, whose pictures reach it as `source.picture` while the daemon plans their encodes
//! (`source.encodes`). `select` decides the backend from the probe, `worker` runs one source's
//! encodes, `platform` holds the real codecs.
pub mod platform;
pub mod select;
pub mod worker;
