// SPDX-License-Identifier: Apache-2.0
//! Pi's durable session references: the header check and the reference file, ported from
//! `packages/adapter-pi/src/session-header.ts` and `session-references.ts`, byte for byte.
//!
//! A reference is `{path, id}`: the native session file and Pi's own id for it. It is encoded
//! as `ace-pi:<base64url(JSON)>`, and saved under `ace-pi-ref:<sha256(JSON)>` so a thread's
//! stored native id never contains a path. Only paths and ids are persisted, never provider
//! credentials or transcript data.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use ace_json::{JsString, Map, Value};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest as _, Sha256};

use super::history::PiHistoryError;

/// `Path`: `z.string().min(1).max(8192)`, absolute (`session-header.ts:7`).
const MAX_PATH_CHARS: usize = 8192;
/// `id`: `z.string().min(1).max(128)`.
const MAX_ID_CHARS: usize = 128;
/// The header read's bound (`session-header.ts:50`).
const HEADER_BYTES: usize = 64 * 1024;
/// `decodeSessionReference`'s value bound (`session-header.ts:24`).
const MAX_REFERENCE_CHARS: usize = 16_384;
/// A saved reference file's bound (`session-references.ts:58`).
const MAX_REFERENCE_FILE_BYTES: u64 = 65_536;
/// The compact reference prefix (`session-references.ts:17`).
const COMPACT: &str = "ace-pi-ref:";
/// The inline reference prefix (`session-header.ts:18`).
const INLINE: &str = "ace-pi:";

/// A native Pi session: its file and Pi's id for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionReference {
    pub path: String,
    pub id: String,
}

/// What `checkedSessionReference` proves: the reference, its header's id and cwd.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedReference {
    pub path: String,
    pub id: String,
    pub cwd: String,
}

/// `JSON.stringify({path, id})`, the bytes the inline form encodes and the hash names.
pub fn reference_json(reference: &SessionReference) -> Result<String, PiHistoryError> {
    let mut map = Map::with_capacity(2);
    map.insert(
        "path",
        Value::String(JsString::from(reference.path.as_str())),
    );
    map.insert("id", Value::String(JsString::from(reference.id.as_str())));
    ace_json::ser::to_string(&Value::Object(map)).map_err(|_| PiHistoryError::Header)
}

/// `SessionReference.parse` on a decoded value.
fn parse_reference(value: &Value) -> Result<SessionReference, PiHistoryError> {
    let map = value.as_object().ok_or(PiHistoryError::Header)?;
    let path = map
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(PiHistoryError::Header)?;
    let id = map
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(PiHistoryError::Header)?;
    validate_path(&path)?;
    validate_id(&id)?;
    Ok(SessionReference { path, id })
}

fn validate_path(path: &str) -> Result<(), PiHistoryError> {
    // zod's `.max()` counts code points (rule 17).
    let points = path.chars().count();
    if points == 0 || points > MAX_PATH_CHARS {
        return Err(PiHistoryError::Header);
    }
    if !Path::new(path).is_absolute() {
        return Err(PiHistoryError::Header);
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), PiHistoryError> {
    let points = id.chars().count();
    if points == 0 || points > MAX_ID_CHARS {
        return Err(PiHistoryError::Header);
    }
    Ok(())
}

/// `encodeSessionReference`: `"ace-pi:"` and the base64url form of the reference's JSON.
pub fn encode_session_reference(reference: &SessionReference) -> Result<String, PiHistoryError> {
    validate_path(&reference.path)?;
    validate_id(&reference.id)?;
    Ok(format!(
        "{INLINE}{}",
        URL_SAFE_NO_PAD.encode(reference_json(reference)?)
    ))
}

/// What a decoded inline reference names: a path, with an id when it is a full reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedReference {
    pub path: String,
    pub id: Option<String>,
}

/// `decodeSessionReference`: `"ace-pi:"` values decode, anything else is a bare path.
pub fn decode_session_reference(value: &str) -> Result<DecodedReference, PiHistoryError> {
    let Some(encoded) = value.strip_prefix(INLINE) else {
        validate_path(value).map_err(|_| PiHistoryError::Header)?;
        return Ok(DecodedReference {
            path: value.to_owned(),
            id: None,
        });
    };
    // `value.length > 16_384` counts UTF-16 units (rule 17).
    if value.encode_utf16().count() > MAX_REFERENCE_CHARS {
        return Err(PiHistoryError::Header);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| PiHistoryError::Header)?;
    let text = String::from_utf8(bytes).map_err(|_| PiHistoryError::Header)?;
    let value = ace_json::parse(&text).map_err(|_| PiHistoryError::Header)?;
    let reference = parse_reference(&value)?;
    Ok(DecodedReference {
        path: reference.path,
        id: Some(reference.id),
    })
}

/// A saved session's header, as `readSessionHeader` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHeader {
    pub id: String,
    pub cwd: String,
}

/// `readSessionHeader`: the first line only, bounded to 64 KiB, never a transcript.
pub fn read_session_header(path: &str) -> Result<SessionHeader, PiHistoryError> {
    validate_path(path).map_err(|_| PiHistoryError::Header)?;
    let mut file = std::fs::File::open(path).map_err(|_| PiHistoryError::Missing)?;
    let mut bytes = vec![0_u8; HEADER_BYTES];
    let mut size = 0;
    let mut end = None;
    while size < bytes.len() && end.is_none() {
        let read = file
            .read(&mut bytes[size..])
            .map_err(|_| PiHistoryError::Header)?;
        if read == 0 {
            break;
        }
        end = bytes[size..size + read]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|at| size + at);
        size += read;
    }
    let Some(end) = end else {
        return Err(PiHistoryError::Header);
    };
    if end >= size {
        return Err(PiHistoryError::Header);
    }
    let line = std::str::from_utf8(&bytes[..end]).map_err(|_| PiHistoryError::Header)?;
    let value = ace_json::parse(line).map_err(|_| PiHistoryError::Header)?;
    let map = value.as_object().ok_or(PiHistoryError::Header)?;
    if map.get("type").and_then(Value::as_str) != Some("session") {
        return Err(PiHistoryError::Header);
    }
    let id = map
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(PiHistoryError::Header)?;
    validate_id(&id).map_err(|_| PiHistoryError::Header)?;
    // `version: z.union([1, 2, 3]).default(1)`: the default covers an absent key only, so a
    // release ace has not audited — and a `null` — is refused.
    match map.get("version") {
        None => {}
        Some(value) => match value.as_f64() {
            Some(version) if version == 1.0 || version == 2.0 || version == 3.0 => {}
            _ => return Err(PiHistoryError::Header),
        },
    }
    let cwd = map
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(PiHistoryError::Header)?;
    validate_path(&cwd).map_err(|_| PiHistoryError::Header)?;
    Ok(SessionHeader { id, cwd })
}

/// `checkedSessionReference`: decode, then prove the file's header names the same session.
pub fn checked_session_reference(value: &str) -> Result<CheckedReference, PiHistoryError> {
    let reference = decode_session_reference(value)?;
    let header = read_session_header(&reference.path)?;
    if let Some(id) = &reference.id
        && *id != header.id
    {
        return Err(PiHistoryError::Identity);
    }
    Ok(CheckedReference {
        path: reference.path,
        id: header.id,
        cwd: header.cwd,
    })
}

/// The reference file's name: `sha256(JSON.stringify({path, id}))`, lowercase hex.
pub fn reference_key(reference: &SessionReference) -> Result<String, PiHistoryError> {
    let digest = Sha256::digest(reference_json(reference)?.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `saveSessionReference`: the file is written to a fresh directory and renamed into place,
/// then the compact id is returned.
pub fn save_session_reference(
    root: &Path,
    reference: &SessionReference,
) -> Result<String, PiHistoryError> {
    validate_path(&reference.path)?;
    validate_id(&reference.id)?;
    let hash = reference_key(reference)?;
    std::fs::create_dir_all(root).map_err(|_| PiHistoryError::Missing)?;
    set_mode(root, 0o700)?;
    // A fresh stage per save (`mkdtemp`): two opens of one reference never share a directory.
    static STAGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let turn = STAGE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let stage = root.join(format!(".publish-{}-{turn}-{hash}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir(&stage).map_err(|_| PiHistoryError::Missing)?;
    let temporary = stage.join("reference.json");
    let path = root.join(format!("{hash}.json"));
    let result = (|| {
        write_private(&temporary, &reference_json(reference)?)?;
        std::fs::rename(&temporary, &path).map_err(|_| PiHistoryError::Missing)
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result?;
    Ok(format!("{COMPACT}{hash}"))
}

/// `loadSessionReference`: a compact id reads its saved file under `root`; anything else is
/// checked in place.
pub fn load_session_reference(
    root: &Path,
    value: &str,
) -> Result<CheckedReference, PiHistoryError> {
    let Some(hash) = value.strip_prefix(COMPACT) else {
        return checked_session_reference(value);
    };
    // `/^ace-pi-ref:([a-f0-9]{64})$/`: uppercase hex is not a compact id, and reads as a path.
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return checked_session_reference(value);
    }
    let path = root.join(format!("{hash}.json"));
    let read = read_reference_file(&path).map_err(|error| match error {
        PiHistoryError::Missing => PiHistoryError::Missing,
        other => other,
    })?;
    if reference_key(&read).map_err(|_| PiHistoryError::Identity)? != hash {
        return Err(PiHistoryError::Identity);
    }
    let saved = checked_session_reference(&read.path)?;
    if saved.id != read.id {
        return Err(PiHistoryError::Identity);
    }
    Ok(saved)
}

fn read_reference_file(path: &Path) -> Result<SessionReference, PiHistoryError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path).map_err(|_| PiHistoryError::Missing)?;
    let info = file.metadata().map_err(|_| PiHistoryError::Missing)?;
    if !info.is_file() || info.len() > MAX_REFERENCE_FILE_BYTES {
        return Err(PiHistoryError::Header);
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|_| PiHistoryError::Header)?;
    // Anything the file's own content gets wrong is "missing", as today's catch-all is.
    let value = ace_json::parse(&text).map_err(|_| PiHistoryError::Missing)?;
    parse_reference(&value).map_err(|_| PiHistoryError::Missing)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), PiHistoryError> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|_| PiHistoryError::Missing)
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), PiHistoryError> {
    Ok(())
}

fn write_private(path: &PathBuf, content: &str) -> Result<(), PiHistoryError> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    use std::io::Write as _;
    let mut file = options.open(path).map_err(|_| PiHistoryError::Missing)?;
    file.write_all(content.as_bytes())
        .map_err(|_| PiHistoryError::Missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ace-pi-ref-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch");
        root
    }

    fn fixture(path: &Path, id: &str) -> String {
        format!(
            "{}\n{}\n",
            ace_json::to_string(&Value::Object({
                let mut map = Map::with_capacity(3);
                map.insert("type", Value::from("session"));
                map.insert("id", Value::from(id));
                map.insert(
                    "cwd",
                    Value::from(path.parent().unwrap_or(path).to_string_lossy().as_ref()),
                );
                map
            })),
            "{\"type\":\"message\"}"
        )
    }

    #[test]
    fn a_reference_round_trips_through_its_inline_encoding() {
        let reference = SessionReference {
            path: "/tmp/native.jsonl".to_owned(),
            id: "native".to_owned(),
        };
        let encoded = encode_session_reference(&reference).expect("encode");
        assert!(encoded.starts_with(INLINE));
        assert_eq!(
            decode_session_reference(&encoded).expect("decode"),
            DecodedReference {
                path: reference.path.clone(),
                id: Some(reference.id.clone())
            }
        );
        // A bare path is a path, and a non-absolute one is refused.
        assert_eq!(
            decode_session_reference("/tmp/plain.jsonl").expect("path"),
            DecodedReference {
                path: "/tmp/plain.jsonl".to_owned(),
                id: None
            }
        );
        assert_eq!(
            decode_session_reference("relative.jsonl").unwrap_err(),
            PiHistoryError::Header
        );
    }

    #[test]
    fn a_checked_reference_proves_the_headers_id_and_a_changed_one_is_refused() {
        let root = scratch("checked");
        let file = root.join("native.jsonl");
        std::fs::write(&file, fixture(&file, "native")).expect("write");
        let path = file.to_string_lossy().to_string();
        let checked = checked_session_reference(
            &encode_session_reference(&SessionReference {
                path: path.clone(),
                id: "native".to_owned(),
            })
            .expect("encode"),
        )
        .expect("checked");
        assert_eq!(checked.id, "native");
        let wrong = encode_session_reference(&SessionReference {
            path,
            id: "other".to_owned(),
        })
        .expect("encode");
        assert_eq!(
            checked_session_reference(&wrong).unwrap_err(),
            PiHistoryError::Identity
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_saved_reference_loads_by_its_compact_id_and_a_missing_one_is_refused() {
        let root = scratch("saved");
        let file = root.join("native.jsonl");
        std::fs::write(&file, fixture(&file, "native")).expect("write");
        let reference = SessionReference {
            path: file.to_string_lossy().to_string(),
            id: "native".to_owned(),
        };
        let saved = save_session_reference(&root.join("references"), &reference).expect("save");
        assert!(saved.starts_with(COMPACT));
        let loaded = load_session_reference(&root.join("references"), &saved).expect("load");
        assert_eq!(loaded.id, "native");
        assert_eq!(loaded.path, reference.path);
        // A file whose content no longer matches its name is refused, never trusted.
        let references = root.join("references");
        let hashed = saved.trim_start_matches(COMPACT);
        let file = references.join(format!("{hashed}.json"));
        std::fs::write(&file, "{}").expect("tamper");
        assert_eq!(
            load_session_reference(&references, &saved).unwrap_err(),
            PiHistoryError::Missing
        );
        std::fs::write(
            &file,
            reference_json(&SessionReference {
                path: "/tmp/other.jsonl".to_owned(),
                id: "other".to_owned(),
            })
            .expect("json"),
        )
        .expect("tamper");
        assert_eq!(
            load_session_reference(&references, &saved).unwrap_err(),
            PiHistoryError::Identity
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_header_version_ace_has_not_audited_is_refused() {
        let root = scratch("version");
        let path = root.join("v.jsonl");
        for (version, ok) in [
            ("", true),
            ("\"version\":1,", true),
            ("\"version\":3,", true),
            ("\"version\":4,", false),
            ("\"version\":\"3\",", false),
            ("\"version\":null,", false),
        ] {
            std::fs::write(
                &path,
                format!("{{\"type\":\"session\",{version}\"id\":\"native\",\"cwd\":\"/tmp\"}}\n"),
            )
            .expect("write");
            let read = read_session_header(&path.to_string_lossy());
            assert_eq!(read.is_ok(), ok, "{version}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_header_read_stops_at_64_kib_and_a_line_that_fits_is_read() {
        let root = scratch("header-bound");
        let path = root.join("bound.jsonl");
        let head = "{\"type\":\"session\",\"id\":\"native\",\"cwd\":\"/tmp\",\"pad\":\"";
        let tail = "\"}";
        // A line whose newline sits at byte 65,535 is inside the 64 KiB read.
        let fits = 65_535 - head.len() - tail.len();
        std::fs::write(&path, format!("{head}{}{tail}\n", "x".repeat(fits))).expect("write");
        assert!(read_session_header(&path.to_string_lossy()).is_ok());
        // One byte longer puts the newline past the window: the header is refused.
        std::fs::write(&path, format!("{head}{}{tail}\n", "x".repeat(fits + 1))).expect("write");
        assert_eq!(
            read_session_header(&path.to_string_lossy()).unwrap_err(),
            PiHistoryError::Header
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_uppercase_compact_id_is_a_path_and_an_inline_value_is_bounded_in_utf16_units() {
        let root = scratch("compact-case");
        let upper = format!("{COMPACT}ABC");
        // Not a compact id: it reads as a bare path, which is not absolute.
        assert_eq!(
            load_session_reference(&root, &upper).unwrap_err(),
            PiHistoryError::Header
        );
        let too_long = format!("{INLINE}{}", "A".repeat(MAX_REFERENCE_CHARS));
        assert_eq!(
            decode_session_reference(&too_long).unwrap_err(),
            PiHistoryError::Header
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_header_without_a_newline_or_without_the_session_type_is_refused() {
        let root = scratch("header");
        let bare = root.join("bare.jsonl");
        std::fs::write(&bare, "{\"type\":\"session\"}").expect("write");
        assert_eq!(
            read_session_header(&bare.to_string_lossy()).unwrap_err(),
            PiHistoryError::Header
        );
        let wrong = root.join("wrong.jsonl");
        std::fs::write(&wrong, "{\"type\":\"message\"}\n").expect("write");
        assert_eq!(
            read_session_header(&wrong.to_string_lossy()).unwrap_err(),
            PiHistoryError::Header
        );
        // An empty file is as untrustworthy as a missing one: neither names a session.
        let empty = root.join("empty.jsonl");
        std::fs::write(&empty, "").expect("write");
        assert_eq!(
            read_session_header(&empty.to_string_lossy()).unwrap_err(),
            PiHistoryError::Header
        );
        assert_eq!(
            read_session_header(&root.join("missing.jsonl").to_string_lossy()).unwrap_err(),
            PiHistoryError::Missing
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
