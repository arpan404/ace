// SPDX-License-Identifier: Apache-2.0
//! ace's own client side of scrcpy's protocol (D3.2, docs/devices/porting-guide.md): the control
//! messages `packages/devices/src/scrcpy-protocol.ts` writes, the plan `scrcpy-input.ts` builds
//! for one input, and the clipboard handshake `scrcpy-clipboard.ts` runs. Every byte layout
//! belongs to the pinned server in `scrcpy-server.ts`; nothing here approximates one.
pub mod clipboard;
pub mod input;
pub mod protocol;
