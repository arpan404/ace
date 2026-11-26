// SPDX-License-Identifier: Apache-2.0
//! Zod's parse of a value, minus validation: the shape table says what each object keeps, in
//! which order, and which defaults an absent key gets (porting guide 5.3b). The walk lives
//! beside the table in `ace-protocol`, so the wire decoders and the column encoders share one
//! implementation.

pub use ace_protocol::shape::{strip, strip_object};
