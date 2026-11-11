//! ace's Node-API add-on. Each function converts JavaScript values to Rust, calls one pure
//! `ace-*` crate and converts the result back; no logic lives here. The TypeScript side
//! (`@ace/native`) checks this surface with a schema when it loads the add-on.

use napi::bindgen_prelude::Uint32Array;
use napi_derive::napi;

/// The add-on's surface version. `@ace/native` refuses an add-on whose version differs from
/// its own, so a stale `dist/ace-native.node` fails loudly at load instead of misbehaving.
/// Bump it with every change to an exported function's name, arguments or result.
#[napi]
pub const SURFACE_VERSION: u32 = 1;

/// The offset just past each `\n` in `bytes`. See `ace_lines::line_ends`.
///
/// # Errors
///
/// A JavaScript `RangeError`-style error when `bytes` is 4 GiB or longer.
#[napi]
pub fn line_ends(bytes: &[u8]) -> napi::Result<Uint32Array> {
    ace_lines::line_ends(bytes)
        .map(Uint32Array::new)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))
}
