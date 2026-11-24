use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::AppState;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    pub draft: String,
    pub publisher: String,
    pub name: String,
    pub version: String,
    pub hash: String,
    pub visibility: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct File {
    pub path: String,
    pub text: String,
    pub executable: bool,
}

fn digest(bytes: &[u8]) -> String {
    crate::code::hex(&Sha256::digest(bytes))
}

pub(super) fn file_digest(file: &File) -> String {
    digest(
        serde_json::to_string(&(&file.path, file.executable, digest(file.text.as_bytes())))
            .unwrap_or_default()
            .as_bytes(),
    )
}

pub(super) fn matches_hash(files: &mut [File], expected: &str) -> bool {
    files.sort_by(|left, right| left.path.encode_utf16().cmp(right.path.encode_utf16()));
    if files.is_empty() || files.windows(2).any(|pair| pair[0].path == pair[1].path) {
        return false;
    }
    let mut contents = Sha256::new();
    for file in files {
        let Ok(line) = serde_json::to_string(&(
            &file.path,
            file.text.len(),
            file.executable,
            digest(file.text.as_bytes()),
        )) else {
            return false;
        };
        contents.update(line);
        contents.update(b"\n");
    }
    crate::code::hex(&contents.finalize()) == expected
}

pub(super) async fn load_key(state: &AppState) -> Option<ring::signature::Ed25519KeyPair> {
    let keys = state.keys.clone()?;
    tokio::task::spawn_blocking(move || {
        let text = keys.store_review_seed().ok()??;
        let hex = text.trim().as_bytes();
        if hex.len() != 64 || !hex.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        let seed: Vec<u8> = hex
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
            .collect::<Option<_>>()?;
        ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed).ok()
    })
    .await
    .ok()?
}

pub(super) fn sign(
    key: &ring::signature::Ed25519KeyPair,
    kind: &str,
    target: &Target,
    mut acknowledged: Vec<String>,
) -> Option<String> {
    acknowledged.sort_unstable();
    let items = digest(&serde_json::to_vec(&acknowledged).ok()?);
    let bytes = serde_json::to_vec(&[
        "ace-spade-market-review/1",
        kind,
        &target.publisher,
        &target.name,
        &target.version,
        &target.hash,
        &target.visibility,
        &target.draft,
        &items,
    ])
    .ok()?;
    let signature = crate::code::hex(key.sign(&bytes).as_ref());
    Some(format!("{items}.{signature}"))
}
