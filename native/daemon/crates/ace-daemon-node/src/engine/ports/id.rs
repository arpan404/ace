// SPDX-License-Identifier: Apache-2.0
//! `timeOrderedIds` (`time-ordered-id.ts:11`), used when no `ids` port was given: the same
//! UUIDv7 layout, the clock and random bytes from the OS.

/// `timeOrderedIds`: UUIDv7, monotonic within one process, an id never repeats.
#[derive(Default)]
pub(super) struct UuidV7 {
    last_ms: u64,
    counter: u16,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    let _ = getrandom::fill(&mut bytes);
    bytes
}

impl UuidV7 {
    pub(super) fn next(&mut self) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0);
        if now > self.last_ms {
            self.last_ms = now;
            // A random start within the lower half leaves room to count up in the same
            // millisecond.
            let seed = random_bytes::<2>();
            self.counter = ((u16::from(seed[0]) << 8) | u16::from(seed[1])) & 0x7ff;
        } else {
            self.counter += 1;
            if self.counter > 0xfff {
                self.last_ms += 1;
                self.counter = 0;
            }
        }
        let mut bytes = [0u8; 16];
        let mut rest = self.last_ms;
        for index in (0..6).rev() {
            bytes[index] = (rest % 256) as u8;
            rest /= 256;
        }
        bytes[6] = 0x70 | ((self.counter >> 8) & 0x0f) as u8;
        bytes[7] = (self.counter & 0xff) as u8;
        let tail = random_bytes::<8>();
        bytes[8] = 0x80 | (tail[0] & 0x3f);
        bytes[9..16].copy_from_slice(&tail[1..8]);
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    }
}
