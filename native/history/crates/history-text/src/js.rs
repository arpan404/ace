// SPDX-License-Identifier: Apache-2.0

//! JavaScript's string, date and number behaviour, where the TypeScript reader relies on it.

/// `\s` in a JavaScript regular expression, as a character class body.
pub const SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Whether `c` is whitespace to `String.prototype.trim`.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `String.prototype.trimStart`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

/// `String.prototype.length`: UTF-16 code units.
pub fn length(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte offset of UTF-16 unit `units`, rounded down to a whole character: JavaScript would
/// cut a surrogate pair there, which a Rust string cannot hold.
pub fn unit_offset(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (offset, c) in text.char_indices() {
        if seen + c.len_utf16() > units {
            return offset;
        }
        seen += c.len_utf16();
    }
    text.len()
}

/// `text.slice(start, end)` in UTF-16 units.
pub fn slice(text: &str, start: usize, end: usize) -> &str {
    let from = unit_offset(text, start);
    let to = unit_offset(text, end).max(from);
    &text[from..to]
}

/// `text.slice(0, units)`.
pub fn prefix(text: &str, units: usize) -> &str {
    &text[..unit_offset(text, units)]
}

/// `new Date(ms).toISOString().slice(0, 10)`.
pub fn iso_day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let text = if (0..=9999).contains(&year) {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        let sign = if year < 0 { '-' } else { '+' };
        format!("{sign}{:06}-{month:02}-{day:02}", year.unsigned_abs())
    };
    text.chars().take(10).collect()
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.parse` for the ECMAScript date-time string format, the one providers write. A date-time
/// without an offset is read as UTC, where JavaScript reads local time; other formats are `None`.
pub fn parse_date(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize, n: usize| -> Option<i64> {
        let part = b.get(*i..*i + n)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *i += n;
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = match b.first()? {
        b'+' | b'-' => {
            let negative = b[0] == b'-';
            i = 1;
            let y = digits(&mut i, 6)?;
            if negative && y == 0 {
                return None;
            }
            if negative { -y } else { y }
        }
        _ => digits(&mut i, 4)?,
    };
    let (mut month, mut day) = (1u32, 1u32);
    if b.get(i) == Some(&b'-') {
        i += 1;
        month = u32::try_from(digits(&mut i, 2)?).ok()?;
        if b.get(i) == Some(&b'-') {
            i += 1;
            day = u32::try_from(digits(&mut i, 2)?).ok()?;
        }
    }
    // JavaScript rolls a day past the month's end into the next month (2026-02-30 is 2026-03-02).
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * 86_400_000;
    if i == b.len() {
        return Some(ms);
    }
    if b.get(i) != Some(&b'T') {
        return None;
    }
    i += 1;
    let hour = digits(&mut i, 2)?;
    if b.get(i) != Some(&b':') {
        return None;
    }
    i += 1;
    let minute = digits(&mut i, 2)?;
    let (mut second, mut milli) = (0, 0);
    if b.get(i) == Some(&b':') {
        i += 1;
        second = digits(&mut i, 2)?;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return None;
            }
            let fraction = &text[start..i];
            let padded = format!("{:0<3}", &fraction[..fraction.len().min(3)]);
            milli = padded.parse().ok()?;
        }
    }
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute | second | milli) != 0) {
        return None;
    }
    ms += ((hour * 60 + minute) * 60 + second) * 1000 + milli;
    match b.get(i) {
        None => Some(ms),
        Some(b'Z') if i + 1 == b.len() => Some(ms),
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'+' { 1 } else { -1 };
            i += 1;
            let oh = digits(&mut i, 2)?;
            if b.get(i) != Some(&b':') {
                return None;
            }
            i += 1;
            let om = digits(&mut i, 2)?;
            if i != b.len() || oh > 23 || om > 59 {
                return None;
            }
            Some(ms - sign * (oh * 60 + om) * 60_000)
        }
        _ => None,
    }
}

/// The largest integer a JavaScript number holds exactly.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `String(n)` for a finite number below 1e21, as fingerprints print `stat` times.
pub fn number(n: f64) -> String {
    format!("{n}")
}
