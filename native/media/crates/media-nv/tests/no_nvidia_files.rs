// SPDX-License-Identifier: Apache-2.0
//! ADR 0148 §3: no NVIDIA header, library or SDK file is ever committed. ace declares its own
//! bindings and loads the person's installed driver at run time.
#![allow(clippy::unwrap_used)]
use std::path::{Path, PathBuf};

const NAMES: [&str; 6] = [
    "nvencodeapi.h",
    "cuviddec.h",
    "nvcuvid.h",
    "nvencodeapi64.dll",
    "nvcuvid.dll",
    "nvcuda.dll",
];
const PREFIXES: [&str; 4] = [
    "libnvidia-encode.so",
    "libnvcuvid.so",
    "libcuda.so",
    "nvencodeapi",
];
/// Identifiers that appear in NVIDIA's interface headers as declarations.
const MARKERS: [&str; 3] = [
    "typedef struct _NV_ENCODE_API_FUNCTION_LIST",
    "typedef struct _CUVIDDECODECREATEINFO",
    "NVENCAPI_MAJOR_VERSION",
];

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !matches!(name.as_str(), "target" | "node_modules" | ".git" | "fuzz") {
                walk(&path, out);
            }
        } else {
            out.push(path);
        }
    }
}

#[test]
fn no_nvidia_header_or_binary_is_in_the_native_tree() {
    // crates/media-nv → native/media → native
    let native = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut files = Vec::new();
    walk(&native, &mut files);
    assert!(files.len() > 10, "walked {}", native.display());
    let mut found = Vec::new();
    for file in files {
        let name = file
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();
        if NAMES.contains(&name.as_str()) || PREFIXES.iter().any(|p| name.starts_with(p)) {
            found.push(file.display().to_string());
            continue;
        }
        let header = matches!(
            file.extension().and_then(|e| e.to_str()),
            Some("h" | "hpp" | "hh")
        );
        if header
            && let Ok(text) = std::fs::read_to_string(&file)
            && MARKERS.iter().any(|m| text.contains(m))
        {
            found.push(file.display().to_string());
        }
    }
    assert!(found.is_empty(), "NVIDIA files committed: {found:?}");
}
