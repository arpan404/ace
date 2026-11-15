//! `stream.configure` (packages/protocol `ScreenHelperRequestV2`): each request is the whole
//! state. `settings` says JPEG stills or H.264 video and its limits; an absent `ingest` means
//! the daemon's pipe; `epoch` is the privacy epoch pictures captured from now on carry.
use crate::{
    codec::Request,
    errors::{Code, Error, Result},
};
use media_ingest::{frame::TOKEN_LEN, Address};
use serde::Deserialize;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamCodec {
    Jpeg,
    H264,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamSettings {
    pub codec: StreamCodec,
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireIngest {
    socket: String,
    token: String,
    /// The ace-media process the daemon started: the only server the pipe may have.
    pid: Option<u32>,
}

#[derive(Debug, PartialEq)]
pub struct Configure {
    pub settings: StreamSettings,
    pub ingest: Option<Address>,
    /// ace-media's process id, with `ingest`: a pipe served by any other process is refused
    /// before the token or a frame is sent (another instance of the name can be created by
    /// any process of this user).
    pub server: Option<u32>,
    pub epoch: Option<u32>,
}

/// ace-media's ingest on Windows is a local named pipe.
const PIPE_PREFIX: &str = r"\\.\pipe\";

pub fn parse(request: &Request) -> Result<Configure> {
    let settings: StreamSettings = request.get("settings")?;
    if !(64..=3840).contains(&settings.max_width)
        || !(64..=3840).contains(&settings.max_height)
        || !(1..=60).contains(&settings.fps)
        || !(128_000..=20_000_000).contains(&settings.bitrate)
    {
        return Err(Error::new(Code::Bounds, "Invalid stream settings"));
    }
    let (ingest, server) = match request.fields.get("ingest") {
        None => (None, None),
        Some(_) => {
            let wire: WireIngest = request.get("ingest")?;
            if !wire.socket.starts_with(PIPE_PREFIX)
                || wire.socket.len() > 256
                || wire.socket[PIPE_PREFIX.len()..].contains(['\\', '/', '\0'])
            {
                return Err(Error::new(
                    Code::Bounds,
                    "Ingest must be a local named pipe",
                ));
            }
            let token = decode_token(&wire.token)
                .ok_or_else(|| Error::new(Code::Bounds, "Ingest token must be 32 bytes"))?;
            let pid = wire
                .pid
                .filter(|pid| *pid != 0)
                .ok_or_else(|| Error::new(Code::Bounds, "Ingest needs ace-media's process id"))?;
            (
                Some(Address {
                    socket: wire.socket,
                    token,
                }),
                Some(pid),
            )
        }
    };
    let epoch = match request.fields.get("epoch") {
        None => None,
        Some(_) => Some(request.get::<u32>("epoch")?),
    };
    Ok(Configure {
        settings,
        ingest,
        server,
        epoch,
    })
}

/// Standard base64 of exactly 32 bytes (44 characters, one `=`).
fn decode_token(text: &str) -> Option<Zeroizing<[u8; TOKEN_LEN]>> {
    let bytes = text.as_bytes();
    if bytes.len() != 44 || bytes[43] != b'=' || bytes[42] == b'=' {
        return None;
    }
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut token = Zeroizing::new([0u8; TOKEN_LEN]);
    let mut out = 0;
    for chunk in bytes[..44].chunks(4) {
        let mut word = 0u32;
        let mut count = 0;
        for &c in chunk {
            if c == b'=' {
                break;
            }
            word = (word << 6) | value(c)?;
            count += 1;
        }
        word <<= 6 * (4 - count);
        for byte in word.to_be_bytes()[1..].iter().take(count - 1) {
            token[out] = *byte;
            out += 1;
        }
    }
    // The last character's unused low bits must be zero (canonical base64).
    (out == TOKEN_LEN && value(bytes[42])? & 0b11 == 0).then_some(token)
}

/// The encode size: the source fitted inside the requested box, never enlarged, with even
/// dimensions (NV12).
pub fn encode_size(source: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    let (w, h) = (source.0.max(2) as f64, source.1.max(2) as f64);
    let scale = (max.0 as f64 / w).min(max.1 as f64 / h).min(1.0);
    let even = |v: f64| ((v * scale).floor() as u32 & !1).max(2);
    (even(w), even(h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    fn request(fields: serde_json::Value) -> Request {
        let mut value = json!({"version":2,"id":"a","op":"stream.configure"});
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        Request::decode(value.to_string().as_bytes()).unwrap()
    }

    fn settings() -> serde_json::Value {
        json!({"codec":"h264","maxWidth":1920,"maxHeight":1080,"fps":60,"bitrate":8000000})
    }

    #[test]
    fn a_request_with_ingest_and_epoch_names_the_pipe_token_and_epoch() {
        let parsed = parse(&request(json!({"settings":settings(),"epoch":3,
            "ingest":{"socket":r"\\.\pipe\ace-media-1-i","token":TOKEN,"pid":4242}})))
        .unwrap();
        assert_eq!(parsed.server, Some(4242));
        let ingest = parsed.ingest.unwrap();
        assert_eq!(ingest.socket, r"\\.\pipe\ace-media-1-i");
        assert_eq!(*ingest.token, std::array::from_fn::<u8, 32, _>(|i| i as u8));
        assert_eq!(
            (parsed.epoch, parsed.settings.codec, parsed.settings.fps),
            (Some(3), StreamCodec::H264, 60)
        );
    }

    #[test]
    fn no_ingest_means_the_daemon_pipe() {
        let parsed = parse(&request(json!({"settings":settings()}))).unwrap();
        assert_eq!(
            (parsed.ingest, parsed.server, parsed.epoch),
            (None, None, None)
        );
    }

    #[test]
    fn bad_requests_are_refused() {
        let bad_pipe = |socket: &str| json!({"settings":settings(),"ingest":{"socket":socket,"token":TOKEN,"pid":7}});
        for fields in [
            json!({"settings":{"codec":"h264","maxWidth":1920,"maxHeight":1080,"fps":61,"bitrate":8000000}}),
            json!({"settings":{"codec":"vp9","maxWidth":1920,"maxHeight":1080,"fps":30,"bitrate":8000000}}),
            bad_pipe("/tmp/ingest.sock"),
            bad_pipe(r"\\server\pipe\x"),
            bad_pipe(r"\\.\pipe\a\b"),
            json!({"settings":settings(),"ingest":{"socket":r"\\.\pipe\x","token":"short"}}),
            json!({"settings":settings(),"ingest":{"socket":r"\\.\pipe\x","token":TOKEN.replace('A', "!"),"pid":7}}),
            // Without ace-media's pid the client could not tell a squatting server from it.
            json!({"settings":settings(),"ingest":{"socket":r"\\.\pipe\x","token":TOKEN}}),
            json!({"settings":settings(),"ingest":{"socket":r"\\.\pipe\x","token":TOKEN,"pid":0}}),
            json!({"settings":settings(),"epoch":-1}),
            json!({"settings":settings(),"epoch":null}),
        ] {
            assert!(parse(&request(fields.clone())).is_err(), "{fields}");
        }
    }

    #[test]
    fn the_encode_size_fits_the_box_never_enlarges_and_is_even() {
        assert_eq!(encode_size((3840, 2160), (1920, 1920)), (1920, 1080));
        assert_eq!(encode_size((1281, 721), (3840, 3840)), (1280, 720));
        assert_eq!(encode_size((1000, 3000), (1920, 1080)), (360, 1080));
    }
}
