// SPDX-License-Identifier: Apache-2.0
//! `simulator-capture.ts`'s endpoint and control decisions: the serve-sim endpoint a helper
//! announces (strictly local, its own port, the device it names), the routes beside its MJPEG
//! stream, the screen's size and orientation on its control socket, the agent still's budget,
//! and the commands a capture starts with. The helper process, sockets, timers and streams are
//! the shell's.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use url::Url;

mod stream;

pub use stream::{
    Delivery, FollowOutcome, FollowPlan, H264Feed, Mode, Published, follow_plan, still_scale,
    to_h264,
};

use crate::platform::{Code, Error, Failure};

/// serve-sim's endpoint must arrive within this long.
pub const STARTUP_MS: u64 = 10_000;
/// The most endpoint metadata ace buffers before refusing it.
pub const METADATA_LIMIT: usize = 8192;
/// The control socket must connect within this long.
pub const CONNECT_MS: u64 = 5_000;
/// How long input waits for the screen's size before using the first picture's.
pub const SIZE_FALLBACK_MS: u64 = 1_000;
/// How long the built-in screens' first read may take.
pub const SCREENS_WAIT_MS: u64 = 3_000;
/// A control message larger than this is ignored.
pub const CONTROL_MESSAGE_MAX: usize = 4096;
/// Control bytes queued in the socket before input is refused rather than delayed.
pub const INPUT_BACKLOG: usize = 65_536;
/// The control tag that announces the screen's size and orientation.
pub const SCREEN_CONFIG_TAG: u8 = 130;
/// The control tag that asks serve-sim for a screen's size.
pub const SCREEN_SIZE_TAG: u8 = 13;
/// The control tag that asks serve-sim for an orientation.
pub const ORIENTATION_TAG: u8 = 7;

/// An agent's still from ace-media: inside the frame packet's bounds and fresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentStill {
    pub max_width: u32,
    pub max_height: u32,
    pub max_pixels: u32,
    pub quality: u8,
    /// Past this the wait ends and `simctl` answers.
    pub deadline_ms: u64,
    pub fresh: bool,
}

pub const AGENT_STILL: AgentStill = AgentStill {
    max_width: 1920,
    max_height: 2160,
    max_pixels: 1920 * 2160,
    quality: 80,
    deadline_ms: 300,
    fresh: true,
};

/// The endpoint serve-sim announces on its stdout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub device: String,
    pub port: u16,
    pub stream_url: String,
    pub ws_url: String,
}

const MALFORMED_ENDPOINT: &str = "Simulator helper endpoint is malformed";

/// The first JSON line a helper printed, as its endpoint, or why it is not one. Parsed as
/// JavaScript does (`ace_json`), so a repeated key keeps its last value rather than failing.
pub fn parse_endpoint(line: &str) -> Result<Endpoint, Error> {
    let malformed = || invalid(MALFORMED_ENDPOINT);
    let value = ace_json::parse(line).map_err(|_| malformed())?;
    let record = value.as_object().ok_or_else(malformed)?;
    let device = record
        .get("device")
        .and_then(|field| field.as_str())
        .ok_or_else(malformed)?;
    if !valid_uuid(device) {
        return Err(malformed());
    }
    let port = record
        .get("port")
        .and_then(|field| field.as_f64())
        .ok_or_else(malformed)?;
    if !port.is_finite() || port.fract() != 0.0 || !(1.0..=65_535.0).contains(&port) {
        return Err(malformed());
    }
    let stream_url = record
        .get("streamUrl")
        .and_then(|field| field.as_str())
        .ok_or_else(malformed)?;
    let ws_url = record
        .get("wsUrl")
        .and_then(|field| field.as_str())
        .ok_or_else(malformed)?;
    if code_points(stream_url) > 4096 || code_points(ws_url) > 4096 {
        return Err(malformed());
    }
    Ok(Endpoint {
        device: device.to_string(),
        port: port as u16,
        stream_url: stream_url.to_string(),
        ws_url: ws_url.to_string(),
    })
}

/// Whether the helper announced the device ace asked about (case-insensitive).
pub fn identity_matches(announced: &str, device: &str) -> bool {
    announced.to_lowercase() == device.to_lowercase()
}

/// A helper route: the scheme it names, on loopback, at the announced port, with no user,
/// password or fragment.
pub fn local_url(value: &str, port: u16, protocol: &str) -> Result<Url, Error> {
    let url =
        Url::parse(value).map_err(|_| invalid("Simulator helper returned a non-local endpoint"))?;
    let local = url.scheme() == protocol.trim_end_matches(':')
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    if !local {
        return Err(invalid("Simulator helper returned a non-local endpoint"));
    }
    Ok(url)
}

/// The device's other serve-sim routes sit beside its announced MJPEG stream.
pub fn sibling(stream: &Url, name: &str) -> Result<Url, Error> {
    let path = stream.path();
    let unexpected = || invalid("Simulator helper returned an unexpected stream route");
    if !path.ends_with("/stream.mjpeg") || stream.query().is_some_and(|query| !query.is_empty()) {
        return Err(unexpected());
    }
    let mut url = stream.clone();
    let prefix = &path[..path.len() - "stream.mjpeg".len()];
    url.set_path(&format!("{prefix}{name}"));
    Ok(url)
}

/// The route beside a stream URL, from its text form.
pub fn sibling_str(stream: &str, name: &str) -> Result<String, Error> {
    let url = Url::parse(stream)
        .map_err(|_| invalid("Simulator helper returned a non-local endpoint"))?;
    sibling(&url, name).map(|url| url.to_string())
}

/// serve-sim announces the screen's size and orientation on its control socket (tag 130).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScreenConfig {
    pub width: u32,
    pub height: u32,
    /// Left out when serve-sim named none: never `null`, which the shell would assign over a
    /// known orientation (before the first picture, and on every key action after it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
}

/// One control message's payload as a screen config, or `None` for anything malformed. Parsed
/// as JavaScript does (`ace_json`), so a repeated key keeps its last value; `orientation` is a
/// zod optional string, so an explicit `null` is not one and refuses the whole report.
pub fn screen_config(payload: &[u8]) -> Option<ScreenConfig> {
    let text = String::from_utf8_lossy(payload);
    let value = ace_json::parse(&text).ok()?;
    let record = value.as_object()?;
    let dimension = |number: f64| {
        number.is_finite() && number.fract() == 0.0 && (1.0..=16_384.0).contains(&number)
    };
    let width = record.get("width")?.as_f64()?;
    let height = record.get("height")?.as_f64()?;
    if !dimension(width) || !dimension(height) {
        return None;
    }
    let orientation = match record.get("orientation") {
        None => None,
        Some(field) => Some(field.as_str()?.to_string()),
    };
    if orientation
        .as_ref()
        .is_some_and(|text| code_points(text) > 64)
    {
        return None;
    }
    Some(ScreenConfig {
        width: width as u32,
        height: height as u32,
        orientation,
    })
}

/// The helper's own arguments: ace's copy runs as `node <script>`, then these.
pub fn spawn_args(command_args: &[String], udid: &str) -> Vec<String> {
    let mut args = command_args.to_vec();
    args.push("--no-preview".to_string());
    args.push("--quiet".to_string());
    args.push(udid.to_string());
    args
}

/// One control frame: its tag, then the JSON payload.
pub fn control_frame(tag: u8, payload: &str) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + payload.len());
    frame.push(tag);
    frame.extend_from_slice(payload.as_bytes());
    frame
}

/// `z.string().uuid()` as zod 4 spells it: version 1-8 and the RFC variant, or nil/all-f.
fn valid_uuid(text: &str) -> bool {
    static UUID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        )
        .unwrap_or_else(|_| unreachable_regex())
    });
    UUID.is_match(text)
}

fn unreachable_regex() -> Regex {
    // The pattern is a compile-time constant; this keeps the crate free of `expect`.
    Regex::new(r"$^").unwrap_or_else(|_| unreachable_regex())
}

fn code_points(text: &str) -> usize {
    text.chars().count()
}

fn invalid(message: &str) -> Error {
    Error::Failed(Failure {
        code: Code::InvalidData,
        message: message.to_string(),
        hint: "Start the device view again.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "8f1f9f6e-4a3f-4c1e-9b2d-1a2b3c4d5e6f";

    fn endpoint(port: f64, stream: &str, ws: &str) -> String {
        format!(r#"{{"device":"{UUID}","port":{port},"streamUrl":"{stream}","wsUrl":"{ws}"}}"#)
    }

    #[test]
    fn an_endpoint_is_the_first_json_line_with_a_uuid_a_port_and_two_bounded_urls() {
        let line = endpoint(
            8080.0,
            "http://127.0.0.1:8080/stream.mjpeg",
            "ws://127.0.0.1:8080/control",
        );
        assert_eq!(
            parse_endpoint(&line).expect("parses"),
            Endpoint {
                device: UUID.to_string(),
                port: 8080,
                stream_url: "http://127.0.0.1:8080/stream.mjpeg".to_string(),
                ws_url: "ws://127.0.0.1:8080/control".to_string()
            }
        );
        for bad in [
            "not json".to_string(),
            endpoint(0.0, "http://127.0.0.1:1/stream.mjpeg", "ws://127.0.0.1:1/x"),
            endpoint(
                65_536.0,
                "http://127.0.0.1:1/stream.mjpeg",
                "ws://127.0.0.1:1/x",
            ),
            endpoint(1.5, "http://127.0.0.1:1/stream.mjpeg", "ws://127.0.0.1:1/x"),
            endpoint(8080.0, &"h".repeat(4097), "ws://127.0.0.1:1/x"),
            line.replace(UUID, "not-a-uuid"),
        ] {
            assert!(parse_endpoint(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_repeated_endpoint_field_keeps_its_last_value_as_json_parse_does() {
        // serde would refuse a repeated key; the shell's JSON.parse keeps the last one.
        let line = format!(
            r#"{{"device":"{UUID}","port":1,"port":8080,"streamUrl":"http://127.0.0.1:8080/stream.mjpeg","wsUrl":"ws://127.0.0.1:8080/control"}}"#
        );
        assert_eq!(
            parse_endpoint(&line).expect("last port wins").port,
            8080,
            "the second port is the endpoint's"
        );
        let bad = format!(
            r#"{{"device":"{UUID}","port":8080,"port":0,"streamUrl":"http://127.0.0.1:8080/stream.mjpeg","wsUrl":"ws://127.0.0.1:8080/control"}}"#
        );
        assert!(
            parse_endpoint(&bad).is_err(),
            "the last port is the one checked"
        );
    }

    #[test]
    fn a_helper_route_must_be_local_at_its_port_without_credentials_or_a_fragment() {
        assert!(local_url("http://127.0.0.1:8080/stream.mjpeg", 8080, "http:").is_ok());
        for bad in [
            "https://127.0.0.1:8080/stream.mjpeg",
            "http://localhost:8080/stream.mjpeg",
            "http://127.0.0.1:9090/stream.mjpeg",
            "http://user@127.0.0.1:8080/stream.mjpeg",
            "http://user:pass@127.0.0.1:8080/stream.mjpeg",
            "http://127.0.0.1:8080/stream.mjpeg#f",
        ] {
            assert!(local_url(bad, 8080, "http:").is_err(), "{bad}");
        }
        // No explicit port is not the announced port.
        assert!(local_url("http://127.0.0.1/stream.mjpeg", 8080, "http:").is_err());
        assert!(identity_matches(&UUID.to_uppercase(), UUID));
    }

    #[test]
    fn the_other_routes_sit_beside_the_announced_stream() {
        let stream =
            local_url("http://127.0.0.1:8080/helper/x/stream.mjpeg", 8080, "http:").expect("local");
        assert_eq!(
            sibling(&stream, "stream.avcc").expect("sibling").as_str(),
            "http://127.0.0.1:8080/helper/x/stream.avcc"
        );
        assert_eq!(
            sibling(&stream, "ax").expect("sibling").as_str(),
            "http://127.0.0.1:8080/helper/x/ax"
        );
        for bad in [
            "http://127.0.0.1:8080/helper/stream.mjpeg?x=1",
            "http://127.0.0.1:8080/helper/stream.mjpegx",
        ] {
            let url = Url::parse(bad).expect("url");
            assert!(sibling(&url, "ax").is_err(), "{bad}");
        }
    }

    #[test]
    fn a_screen_config_is_a_bounded_size_and_an_at_most_64_code_point_orientation() {
        assert_eq!(
            screen_config(br#"{"width":1206,"height":2622,"orientation":"landscape_left"}"#),
            Some(ScreenConfig {
                width: 1206,
                height: 2622,
                orientation: Some("landscape_left".to_string())
            })
        );
        assert_eq!(
            screen_config(br#"{"width":1,"height":16384}"#),
            Some(ScreenConfig {
                width: 1,
                height: 16384,
                orientation: None
            })
        );
        for bad in [
            &br#"{"width":0,"height":10}"#[..],
            &br#"{"width":10,"height":16385}"#[..],
            &br#"{"width":10.5,"height":10}"#[..],
            &br#"{"width":10}"#[..],
            &br#"not json"#[..],
        ] {
            assert_eq!(screen_config(bad), None);
        }
        // A zod string bound counts code points: 64 emoji pass, 65 do not.
        let emoji = "\u{1f600}".repeat(64);
        let json = format!(r#"{{"width":10,"height":10,"orientation":"{emoji}"}}"#);
        assert!(screen_config(json.as_bytes()).is_some());
        let too_long = format!(
            r#"{{"width":10,"height":10,"orientation":"{}"}}"#,
            "\u{1f600}".repeat(65)
        );
        assert_eq!(screen_config(too_long.as_bytes()), None);
    }

    #[test]
    fn a_screen_config_without_an_orientation_leaves_the_key_out_and_a_null_refuses_the_report() {
        let config = screen_config(br#"{"width":1206,"height":2622,"width":10}"#);
        assert_eq!(
            config,
            Some(ScreenConfig {
                width: 10,
                height: 2622,
                orientation: None
            }),
            "a repeated width keeps its last value"
        );
        let text = ace_json::ser::to_string(&config.expect("config")).expect("serializes");
        assert_eq!(
            text, r#"{"width":10,"height":2622}"#,
            "no orientation key, never a null the shell would assign over the screen's"
        );
        // z.string().optional() takes a missing key, not an explicit null.
        assert_eq!(
            screen_config(br#"{"width":10,"height":10,"orientation":null}"#),
            None
        );
        assert_eq!(
            screen_config(br#"{"width":10,"height":10,"orientation":7}"#),
            None
        );
    }

    #[test]
    fn a_capture_starts_with_no_preview_and_quiet_then_the_udids_arguments() {
        assert_eq!(
            spawn_args(&["/tools/serve-sim.js".to_string()], UUID),
            vec![
                "/tools/serve-sim.js".to_string(),
                "--no-preview".to_string(),
                "--quiet".to_string(),
                UUID.to_string()
            ]
        );
        assert_eq!(control_frame(7, r#"{"orientation":"portrait"}"#), {
            let mut expected = vec![7];
            expected.extend_from_slice(br#"{"orientation":"portrait"}"#);
            expected
        });
        assert_eq!(
            (AGENT_STILL.max_width, AGENT_STILL.max_height),
            (1920, 2160)
        );
        assert!((AGENT_STILL.max_pixels as f64) <= 1920.0 * 2160.0);
    }
}
