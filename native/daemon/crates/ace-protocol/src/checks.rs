// SPDX-License-Identifier: Apache-2.0
//! The `.refine()` and `.superRefine()` rules `packages/protocol` states on schema nodes, ported
//! one for one. The shape table names one of these for every reachable Zod check; the generator
//! refuses to write a table when a check has no entry here (porting guide 5.3b).
//!
//! Each function receives the value Zod's own checks would receive: the node after the checks
//! before it ran (a trimmed string, a defaulted object). JavaScript's units are kept: string
//! lengths that the TypeScript compares with `.length` are UTF-16 code units, byte limits are
//! UTF-8 bytes, and `Object.keys` counts own keys including `__proto__`.

use ace_json::{Map, Value};
use unicode_segmentation::UnicodeSegmentation;

use crate::shape::{Check, js_trim};

macro_rules! checks {
    ($($name:ident => $function:ident),* $(,)?) => {
        $(
            /// One Zod refinement, by the name the generated table uses.
            pub static $name: Check = Check($function);
        )*
    };
}

checks! {
    REVIEWERS_PRESENT => reviewers_present,
    ANCHOR_LINES_MATCH => anchor_lines_match,
    COMMAND_NO_NUL => command_no_nul,
    FINGERPRINT_SIZE => fingerprint_size,
    SEARCH_DATES_ORDER => search_dates_order,
    NOT_RESERVED_ID => not_reserved_id,
    IMAGES_KEY_LIMIT => images_key_limit,
    CONTAINED_PATH => contained_path,
    UTF8_2048 => utf8_2048,
    RANGE_ORDERED => range_ordered,
    MODEL_ROW_8192 => model_row_8192,
    NO_LEADING_DASH_OR_DOT => no_leading_dash_or_dot,
    FILE_NAME => file_name,
    NOT_ACE => not_ace,
    LINE_RANGE => line_range,
    NO_NUL_PATH => no_nul_path,
    NO_PARENT_PATH => no_parent_path,
    REVIEW_PATH => review_path,
    USAGE_QUERY => usage_query,
    REVISION_REF => revision_ref,
    SERVERS_KEY_LIMIT => servers_key_limit,
    LANES_BUDGET => lanes_budget,
    UTF8_4096 => utf8_4096,
    USAGE_SCOPE => usage_scope,
    DEFAULT_MATCHES_TYPE => default_matches_type,
    NO_DOUBLE_DASH => no_double_dash,
    NO_DOTDOT_OR_DOUBLE_DASH => no_dotdot_or_double_dash,
    NO_NUL => no_nul,
    NO_CONTROL => no_control,
    KEYS_24 => keys_24,
    KEYS_32 => keys_32,
    KEYS_64 => keys_64,
    PROJECT_ICON_URL => project_icon_url,
    SPADE_REQUEST_BYTES => spade_request_bytes,
    UTF8_65536 => utf8_65536,
    NOT_DOT_OR_DOTDOT => not_dot_or_dotdot,
    FILE_NAME_NO_SLASH_NUL => file_name_no_slash_nul,
    START_AT_MINUTE => start_at_minute,
    PROJECT_DIR_NAME => project_dir_name,
    DRIVER_OR_MODE => driver_or_mode,
    SOURCE_CONTROL_GITHUB_ACCOUNT => source_control_github_account,
    SOURCE_CONTROL_HOST_PROVIDER => source_control_host_provider,
    SOURCE_CONTROL_HOSTS_UNIQUE => source_control_hosts_unique,
    LENGTH_AT_LEAST_3 => length_at_least_3,
    MODEL_NEEDS_PROVIDER => model_needs_provider,
    NUMBER_XOR_ALL => number_xor_all,
    NO_DOT_PARTS => no_dot_parts,
    HTTPS_ONLY => https_only,
    COMMANDS_TARGET_XOR => commands_target_xor,
    NONBLANK => nonblank,
    TITLE_NO_NEWLINE => title_no_newline,
    URL_HTTPS_WSS => url_https_wss,
    ICON_GLYPH => icon_glyph,
    MCP_URL => mcp_url,
    TIMEZONE => timezone,
}

fn object(value: &Value) -> Option<&Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn array(value: &Value) -> Option<&ace_json::Array> {
    match value {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

fn text(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    }
}

fn field<'a>(map: &'a Map, key: &str) -> Option<&'a Value> {
    map.get(key)
}

fn number(map: &Map, key: &str) -> Option<f64> {
    match map.get(key) {
        Some(Value::Number(number)) => Some(number.value()),
        _ => None,
    }
}

fn bool_at(map: &Map, key: &str) -> Option<bool> {
    match map.get(key) {
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn keys(map: &Map, limit: usize) -> bool {
    map.len() <= limit
}

fn keys_24(value: &Value) -> bool {
    object(value).is_some_and(|map| keys(map, 24))
}

fn keys_32(value: &Value) -> bool {
    object(value).is_some_and(|map| keys(map, 32))
}

fn keys_64(value: &Value) -> bool {
    object(value).is_some_and(|map| keys(map, 64))
}

fn images_key_limit(value: &Value) -> bool {
    object(value).is_some_and(|map| keys(map, 256))
}

fn servers_key_limit(value: &Value) -> bool {
    object(value).is_some_and(|map| keys(map, 256))
}

fn reviewers_present(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let reviewers = field(map, "reviewers")
        .and_then(array)
        .map(|items| items.len())
        .unwrap_or(0);
    let teams = field(map, "teams")
        .and_then(array)
        .map(|items| items.len())
        .unwrap_or(0);
    reviewers + teams > 0
}

fn anchor_lines_match(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let (Some(position), Some(fingerprint)) = (field(map, "position"), field(map, "fingerprint"))
    else {
        return false;
    };
    let (Some(position), Some(fingerprint)) = (object(position), object(fingerprint)) else {
        return false;
    };
    let (Some(start), Some(end)) = (number(position, "start"), number(position, "end")) else {
        return false;
    };
    let lines = field(fingerprint, "lines")
        .and_then(array)
        .map(|items| items.len())
        .unwrap_or(usize::MAX);
    (end - start + 1.0) == lines as f64
}

fn command_no_nul(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let Some(command) = field(map, "command").and_then(array) else {
        return false;
    };
    let Some(first) = command.first() else {
        return false;
    };
    let truthy = match first {
        Value::String(text) => !text.is_empty(),
        Value::Bool(value) => *value,
        Value::Number(number) => number.value() != 0.0,
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    };
    truthy
        && command
            .iter()
            .all(|argument| text(argument).is_some_and(|argument| !argument.contains('\u{0}')))
}

fn fingerprint_size(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let mut total = 0u64;
    for key in ["before", "lines", "after"] {
        let Some(entries) = field(map, key).and_then(array) else {
            return false;
        };
        for entry in entries {
            let Some(entry) = entry.as_js_str() else {
                return false;
            };
            total += entry.len_utf16() as u64;
        }
    }
    total <= 8192
}

fn search_dates_order(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    match (number(map, "after"), number(map, "before")) {
        (Some(after), Some(before)) => after <= before,
        _ => true,
    }
}

fn not_reserved_id(value: &Value) -> bool {
    text(value).is_none_or(|value| !matches!(value, "__proto__" | "constructor" | "prototype"))
}

fn contained_path(value: &Value) -> bool {
    let Some(input) = text(value) else {
        return false;
    };
    let value = input.strip_prefix("./").unwrap_or(input);
    if value.contains('\\')
        || value
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || value.chars().any(|c| (c as u32) < 32 || (c as u32) == 127)
        || value.starts_with('/')
    {
        return false;
    }
    value.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !is_device_name(part)
            && !matches!(part, ".git" | "__proto__" | "constructor" | "prototype")
            && !part.ends_with(['.', ' '])
    })
}

fn is_device_name(part: &str) -> bool {
    let lower = part.to_ascii_lowercase();
    let base = lower.split('.').next().unwrap_or("");
    matches!(
        base,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

fn utf8_2048(value: &Value) -> bool {
    text(value).is_some_and(|value| value.len() <= 2048)
}

fn utf8_4096(value: &Value) -> bool {
    text(value).is_some_and(|value| value.len() <= 4096)
}

fn utf8_65536(value: &Value) -> bool {
    text(value).is_some_and(|value| value.len() <= 65536)
}

fn range_ordered(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    match (number(map, "start"), number(map, "end")) {
        (Some(start), Some(end)) => end >= start,
        _ => false,
    }
}

fn line_range(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    match (number(map, "start"), number(map, "end")) {
        (Some(start), Some(end)) => end >= start && end - start < 100.0,
        _ => false,
    }
}

fn model_row_8192(value: &Value) -> bool {
    ace_json::to_string(value).len() <= 8192
}

fn spade_request_bytes(value: &Value) -> bool {
    ace_json::to_string(value).len() <= 512 * 1024
}

fn no_leading_dash_or_dot(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.starts_with('-') && !value.starts_with('.'))
}

fn file_name(value: &Value) -> bool {
    text(value).is_some_and(|value| {
        value != "."
            && value != ".."
            && !value.contains(['/', '\\'])
            && !value.chars().any(|c| (c as u32) < 32 || (c as u32) == 127)
    })
}

fn not_ace(value: &Value) -> bool {
    text(value).is_none_or(|value| value != "ace")
}

fn no_nul_path(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.contains('\u{0}'))
}

fn no_parent_path(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.split('/').any(|part| part == ".."))
}

fn review_path(value: &Value) -> bool {
    text(value).is_some_and(|path| {
        !path.starts_with('/')
            && !path.contains('\\')
            && path.chars().all(|c| (c as u32) >= 32)
            && !is_drive_prefix(path)
            && path
                .split('/')
                .all(|part| part != ".." && part != "." && !part.is_empty())
    })
}

fn is_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn revision_ref(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.starts_with('-') && !value.contains('\u{0}'))
}

fn lanes_budget(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let lanes = field(map, "lanes").and_then(array).map(|items| items.len());
    let max_lanes = field(map, "budget")
        .and_then(object)
        .and_then(|budget| number(budget, "maxLanes"));
    let (Some(lanes), Some(max_lanes)) = (lanes, max_lanes) else {
        return false;
    };
    if lanes as f64 > max_lanes {
        return false;
    }
    if text(field(map, "kind").unwrap_or(&Value::Null)) == Some("coordinator") {
        return lanes == 1;
    }
    true
}

fn usage_scope(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    if map.get("usageScope").is_none() {
        return true;
    }
    if text(map.get("usageScope").unwrap_or(&Value::Null)) == Some("agent") {
        return true;
    }
    map.get("counterKey").is_some()
}

fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

fn default_matches_type(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let Some(default) = map.get("default") else {
        return true;
    };
    text(map.get("type").unwrap_or(&Value::Null)) == Some(js_typeof(default))
}

fn no_double_dash(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.contains("--"))
}

fn no_dotdot_or_double_dash(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.contains("..") && !value.contains("--"))
}

fn no_nul(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.contains('\u{0}'))
}

fn no_control(value: &Value) -> bool {
    text(value).is_some_and(|value| value.chars().all(|c| (c as u32) >= 32))
}

fn project_icon_url(value: &Value) -> bool {
    text(value).is_some_and(|value| url::Url::parse(value).is_ok())
}

fn not_dot_or_dotdot(value: &Value) -> bool {
    text(value).is_some_and(|value| value != "." && value != "..")
}

fn file_name_no_slash_nul(value: &Value) -> bool {
    text(value)
        .is_some_and(|value| value != "." && value != ".." && !value.contains(['/', '\u{0}']))
}

fn start_at_minute(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.value() % 60_000.0 == 0.0,
        _ => false,
    }
}

fn project_dir_name(value: &Value) -> bool {
    text(value).is_some_and(|value| {
        value == js_trim(value) && value != "." && value != ".." && !value.ends_with('.')
    })
}

fn driver_or_mode(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    map.get("driver").is_some() || map.get("mode").is_some()
}

fn github_account(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
        && value.len() <= 100
}

fn configured_forge(entry: &Map) -> &'static str {
    if let Some(forge) = text(entry.get("forge").unwrap_or(&Value::Null)) {
        return match forge {
            "github" => "github",
            "gitlab" => "gitlab",
            "gitbucket" => "gitbucket",
            "bitbucket" => "bitbucket",
            "gitea" => "gitea",
            "forgejo" => "forgejo",
            "origin" => "origin",
            _ => "github",
        };
    }
    match text(entry.get("host").unwrap_or(&Value::Null)).unwrap_or("") {
        "github.com" => "github",
        "gitlab.com" => "gitlab",
        "bitbucket.org" => "bitbucket",
        "codeberg.org" => "forgejo",
        "origin.cursor.com" => "origin",
        _ => "github",
    }
}

fn source_control_github_account(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let Some(hosts) = field(map, "hosts").and_then(array) else {
        return false;
    };
    hosts.iter().all(|entry| {
        let Some(entry) = object(entry) else {
            return false;
        };
        configured_forge(entry) != "github"
            || entry
                .get("account")
                .and_then(|account| text(account))
                .is_none_or(github_account)
    })
}

fn provider_matches_host(entry: &Map) -> bool {
    let host = text(entry.get("host").unwrap_or(&Value::Null)).unwrap_or("");
    let fixed = match host {
        "github.com" => Some("github"),
        "gitlab.com" => Some("gitlab"),
        "bitbucket.org" => Some("bitbucket"),
        "codeberg.org" => Some("forgejo"),
        "origin.cursor.com" => Some("origin"),
        _ => None,
    };
    let forge = configured_forge(entry);
    fixed.is_none_or(|fixed| fixed == forge) && (forge != "origin" || host == "origin.cursor.com")
}

fn source_control_host_provider(value: &Value) -> bool {
    object(value)
        .and_then(|map| field(map, "hosts"))
        .and_then(array)
        .is_some_and(|hosts| {
            hosts
                .iter()
                .all(|entry| object(entry).is_some_and(provider_matches_host))
        })
}

fn source_control_hosts_unique(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let Some(hosts) = field(map, "hosts").and_then(array) else {
        return false;
    };
    let host = text(map.get("host").unwrap_or(&Value::Null));
    if !hosts.iter().any(|entry| {
        object(entry).and_then(|entry| text(entry.get("host").unwrap_or(&Value::Null))) == host
    }) {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    for entry in hosts {
        let Some(entry_host) = object(entry)
            .and_then(|entry| text(entry.get("host").unwrap_or(&Value::Null)))
            .map(str::to_string)
        else {
            return false;
        };
        if !seen.insert(entry_host) {
            return false;
        }
    }
    true
}

fn length_at_least_3(value: &Value) -> bool {
    match value {
        Value::String(text) => text.len_utf16() >= 3,
        _ => false,
    }
}

fn model_needs_provider(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    map.get("model").is_none() || map.get("provider").is_some()
}

fn number_xor_all(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let has_number = map.get("number").is_some();
    let all = bool_at(map, "all") == Some(true);
    has_number != all
}

fn no_dot_parts(value: &Value) -> bool {
    text(value).is_some_and(|value| !value.split('/').any(|part| part == "." || part == ".."))
}

fn https_only(value: &Value) -> bool {
    text(value).is_some_and(|value| value.starts_with("https://"))
}

fn commands_target_xor(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    map.get("threadId").is_some() != map.get("draft").is_some()
}

fn nonblank(value: &Value) -> bool {
    text(value).is_some_and(|value| !js_trim(value).is_empty())
}

fn title_no_newline(value: &Value) -> bool {
    text(value)
        .is_some_and(|value| !js_trim(value).is_empty() && !value.contains(['\r', '\n', '\u{0}']))
}

fn url_https_wss(value: &Value) -> bool {
    text(value).is_some_and(|value| {
        url::Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "wss")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
    })
}

fn mcp_url(value: &Value) -> bool {
    text(value).is_some_and(|value| {
        url::Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
    })
}

fn timezone(value: &Value) -> bool {
    text(value).is_some_and(|value| jiff::tz::TimeZone::get(value).is_ok())
}

fn icon_glyph(value: &Value) -> bool {
    let Some(value) = text(value) else {
        return false;
    };
    if value
        .chars()
        .any(|c| c.is_whitespace() || c == '\u{feff}' || c.is_control() || is_format(c))
    {
        return false;
    }
    if value.chars().any(is_pictographic) {
        return false;
    }
    value.graphemes(true).count() <= 2
}

fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}'
            | '\u{061c}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

fn is_pictographic(c: char) -> bool {
    matches!(
        c as u32,
        0x1f000..=0x1faff | 0x2600..=0x27bf | 0x2b00..=0x2bff | 0x20e3
    )
}

fn usage_query(value: &Value) -> bool {
    let Some(map) = object(value) else {
        return false;
    };
    let (Some(from), Some(to)) = (
        text(map.get("from").unwrap_or(&Value::Null)),
        text(map.get("to").unwrap_or(&Value::Null)),
    ) else {
        return false;
    };
    let (Some(from), Some(to)) = (parse_iso_date(from), parse_iso_date(to)) else {
        return false;
    };
    let span = to - from;
    if !(0..=365).contains(&span) {
        return false;
    }
    let Some(group_by) = field(map, "groupBy").and_then(array) else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    group_by
        .iter()
        .all(|value| text(value).is_some_and(|value| seen.insert(value.to_string())))
}

fn parse_iso_date(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = text.get(0..4)?.parse::<i64>().ok()?;
    let month = text.get(5..7)?.parse::<i64>().ok()?;
    let day = text.get(8..10)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// Days since 1970-01-01 for a proleptic Gregorian date, as JavaScript's `Date.parse` reads it.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}
