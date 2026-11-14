// SPDX-License-Identifier: Apache-2.0
// K1's hex fields are ASCII without escapes. Keep fixture loading dependency-free.
pub fn hex_fields(json: &str) -> Vec<Vec<u8>> {
    json.split("\"hex\": \"")
        .skip(1)
        .map(|tail| {
            let hex = tail.split('"').next().unwrap_or("");
            hex.as_bytes()
                .chunks_exact(2)
                .map(|pair| {
                    let digit = |b: u8| match b {
                        b'0'..=b'9' => b - b'0',
                        b'a'..=b'f' => b - b'a' + 10,
                        _ => panic!("invalid fixture hex"),
                    };
                    digit(pair[0]) * 16 + digit(pair[1])
                })
                .collect()
        })
        .collect()
}
