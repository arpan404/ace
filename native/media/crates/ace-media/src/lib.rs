// SPDX-License-Identifier: Apache-2.0
//! ace-media, the media process (ADR 0147). Pure decisions live in [`engine`], [`auth`] and
//! [`probe`]'s merge rules; [`shell`] is the thin I/O around them.
pub mod acceleration;
pub mod auth;
pub mod encode;
pub mod engine;
pub mod framing;
pub mod image_cli;
pub mod images;
pub mod lane_cipher;
pub mod os;
pub mod probe;
pub mod rank;
pub mod record;
pub mod secret;
pub mod serve_sim;
pub mod shell;
pub mod stills;
pub mod trials;
