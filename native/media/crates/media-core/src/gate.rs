// SPDX-License-Identifier: Apache-2.0
//! One instance per capture/encode pair; the owner removes it when capture ends.
#[derive(Default, Debug)]
pub struct ChunkGate {
    broken: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    pub sent: bool,
    pub keyframe: bool,
}
impl ChunkGate {
    pub fn offer(&mut self, key: bool, send: impl FnOnce() -> bool) -> Outcome {
        if self.broken && !key {
            return Outcome {
                sent: false,
                keyframe: false,
            };
        }
        if send() {
            self.broken = false;
            return Outcome {
                sent: true,
                keyframe: false,
            };
        }
        let keyframe = !self.broken || key;
        self.broken = true;
        Outcome {
            sent: false,
            keyframe,
        }
    }
}
/// Whole-picture admission from picture-channel.ts. Retry scheduling belongs to the shell.
pub fn live_admitted(closed: bool, queued: usize, buffered: usize) -> bool {
    !closed && queued < 4 && buffered <= 512 * 1024
}
pub fn still_admitted(closed: bool, queued: usize, buffered: usize) -> bool {
    !closed && queued < 8 && buffered <= 128 * 1024
}
