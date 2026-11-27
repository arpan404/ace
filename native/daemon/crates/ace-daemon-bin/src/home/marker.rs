// SPDX-License-Identifier: Apache-2.0
//! The home's marker bytes, backup names and ISO times.

/// `backupName`: `<home>-v<from>`, then `.1`, `.2` and so on; never an existing one.
pub fn backup_name(home: &str, from: u32, taken: impl Fn(&str) -> bool) -> Option<String> {
    let base = format!("{home}-v{from}");
    if !taken(&base) {
        return Some(base);
    }
    for index in 1..=10_000 {
        let name = format!("{base}.{index}");
        if !taken(&name) {
            return Some(name);
        }
    }
    None
}

/// `new Date(ms).toISOString()`, without a calendar crate: UTC, milliseconds.
pub fn iso8601(millis: u64) -> String {
    let seconds = millis / 1000;
    let millis = millis % 1000;
    let days = (seconds / 86_400) as i64;
    let of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        of_day / 3600,
        (of_day / 60) % 60,
        of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to a civil date.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}
