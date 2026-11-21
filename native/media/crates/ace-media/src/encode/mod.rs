// SPDX-License-Identifier: Apache-2.0
//! JPEG sources ace-media encodes itself (E4, X2): private-context screencasts, "Use my Chrome"
//! tabs and JPEG-only screens, whose pictures reach it as still-picture frames on their ingest
//! connection while the daemon plans their encodes
//! (`source.encodes`). `select` decides the backend from the probe, `worker` runs one source's
//! encodes, `platform` holds the real codecs.
pub mod platform;
pub mod select;
pub mod worker;
