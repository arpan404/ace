// SPDX-License-Identifier: Apache-2.0
//! The publication safety scan (`publication-credentials.ts`, `publication-assignment-keys.ts`,
//! `publication-sensitive.ts`, `publication-yaml.ts`, `publication-scan.ts`; G3d).
//!
//! Proof: every case of `publication-sensitive.test.ts` moved to this module's tests, and the
//! feature-level wiring in the daemon's publication process files.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

pub mod credentials;
pub mod yaml;

pub use credentials::{
    Assignment, contains_publication_credential, has_sensitive_span, is_publication_credential_key,
    publication_assignments,
};

pub(crate) use credentials::regex_of;
pub use yaml::assert_publication_yaml;

use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked};

/// `metadataLimit`: bytes of a metadata read (tree listings, rev-list).
pub const METADATA_LIMIT: usize = 8 * 1024 * 1024;
/// `contentLimit`: total object bytes one scan inspects.
pub const CONTENT_LIMIT: u64 = 128 * 1024 * 1024;
/// `objectLimit`: the largest single object one scan inspects.
pub const OBJECT_LIMIT: u64 = 8 * 1024 * 1024;
/// The most objects one scan collects.
pub const OBJECT_COUNT_LIMIT: usize = 100_000;
/// The largest YAML one scan parses.
pub const YAML_BYTE_LIMIT: usize = 1024 * 1024;
/// The most documents one YAML file may hold.
pub const YAML_DOCUMENT_LIMIT: usize = 20;
/// The most nodes one YAML document set may hold.
pub const YAML_NODE_LIMIT: usize = 100_000;
/// The deepest YAML nesting one scan walks.
pub const YAML_DEPTH_LIMIT: usize = 64;

pub fn incomplete_publication_scan() -> GitError {
    GitError::new(
        GitErrorCode::PublicationScanIncomplete,
        "Publication safety scan incomplete",
    )
}

pub(crate) fn sensitive_publication() -> GitError {
    GitError::new(
        GitErrorCode::SensitivePublication,
        "Sensitive publication content",
    )
}

/// A path publication must refuse: a credential store, a key or an `.env`-like file.
pub fn sensitive_publication_path(path: &str) -> bool {
    static STORES: OnceLock<Option<Regex>> = OnceLock::new();
    static NAMES: OnceLock<Option<Regex>> = OnceLock::new();
    static SUFFIXES: OnceLock<Option<Regex>> = OnceLock::new();
    if has_sensitive_span(path) {
        return true;
    }
    path.split('/').any(|part| {
        let lowered = part.to_ascii_lowercase();
        lowered.starts_with(".env")
            || lowered.contains("kubeconfig")
            || regex_of(&STORES, r"(?i)^(?:\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.oci|\.gcloud|gcloud|\.boto|\.s3cfg|\.terraformrc|terraform\.rc|\.terraform\.d|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$")
                .is_some_and(|pattern| pattern.is_match(part))
            || regex_of(&NAMES, r"(?i)^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:[._-].*)?|.*[._-]credentials?(?:[._-].*)?|service[-_]account.*\.json|secrets?(?:[._-].*)?)$")
                .is_some_and(|pattern| pattern.is_match(part))
            || regex_of(&SUFFIXES, r"(?i)\.(?:pem|der|key|p12|pfx|jks|keystore)$")
                .is_some_and(|pattern| pattern.is_match(part))
    })
}

/// Blobs under these names also get structured YAML credential inspection.
pub fn publication_yaml_name(name: &str) -> bool {
    static YAML: OnceLock<Option<Regex>> = OnceLock::new();
    regex_of(&YAML, r"(?i)\.ya?ml$").is_some_and(|pattern| pattern.is_match(name))
}

/// `assertPublicationText`: credentials in bytes, or a pointer the scan cannot inspect.
pub fn assert_publication_text(bytes: &[u8]) -> Result<(), GitError> {
    let text = String::from_utf8_lossy(bytes);
    if contains_publication_credential(&text)? {
        return Err(sensitive_publication());
    }
    if text.starts_with("version https://git-lfs.github.com/spec/v1") {
        return Err(incomplete_publication_scan());
    }
    Ok(())
}

/// One object a publication scan inspects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanObject {
    pub id: String,
    pub object_type: String,
    pub size: u64,
    pub format_yaml: bool,
}

/// One child object a tree or commit names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationReference {
    pub id: String,
    pub format_yaml: bool,
}

/// `objectHeader`: `<id> <type> <size>` from a `cat-file --batch-check` line.
pub fn object_header(line: &str) -> Result<ScanObject, GitError> {
    let mut parts = line.split(' ');
    let (Some(id), Some(object_type), Some(size)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(incomplete_publication_scan());
    };
    if parts.next().is_some() || size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(incomplete_publication_scan());
    }
    if crate::core::decode::hash_schema(id).is_none()
        || !matches!(object_type, "blob" | "tree" | "commit" | "tag")
    {
        return Err(incomplete_publication_scan());
    }
    Ok(ScanObject {
        id: id.to_owned(),
        object_type: object_type.to_owned(),
        size: crate::core::decode::count(size)?,
        format_yaml: false,
    })
}

/// Binary tree names are inspected independently of blobs, including reused or renamed content.
pub fn assert_publication_tree(
    bytes: &[u8],
    hash_bytes: usize,
) -> Result<Vec<PublicationReference>, GitError> {
    let mut children = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let space = match bytes[offset..].iter().position(|byte| *byte == b' ') {
            Some(index) => offset + index,
            None => return Err(incomplete_publication_scan()),
        };
        let end = match bytes[space + 1..].iter().position(|byte| *byte == 0) {
            Some(index) => space + 1 + index,
            None => return Err(incomplete_publication_scan()),
        };
        if end + 1 + hash_bytes > bytes.len() {
            return Err(incomplete_publication_scan());
        }
        let Ok(name) = std::str::from_utf8(&bytes[space + 1..end]) else {
            return Err(incomplete_publication_scan());
        };
        if sensitive_publication_path(name) {
            return Err(GitError::new(
                GitErrorCode::SensitivePublication,
                "Sensitive publication path",
            ));
        }
        let mode = String::from_utf8_lossy(&bytes[offset..space]).into_owned();
        if mode != "160000" {
            children.push(PublicationReference {
                id: bytes[end + 1..end + 1 + hash_bytes]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                format_yaml: mode != "40000" && mode != "040000" && publication_yaml_name(name),
            });
        }
        offset = end + 1 + hash_bytes;
    }
    Ok(children)
}

/// Parse the byte-framed batch result. Raw content never becomes diagnostics or a receipt.
pub fn inspect_publication_batch(
    bytes: &[u8],
    expected: &[ScanObject],
) -> Result<Vec<PublicationReference>, GitError> {
    let mut children = Vec::new();
    let mut offset = 0usize;
    for object in expected {
        let end = match bytes[offset..].iter().position(|byte| *byte == b'\n') {
            Some(index) => offset + index,
            None => return Err(incomplete_publication_scan()),
        };
        let header = String::from_utf8_lossy(&bytes[offset..end]);
        let actual = object_header(header.trim_end())?;
        if actual.id != object.id
            || actual.object_type != object.object_type
            || actual.size != object.size
        {
            return Err(incomplete_publication_scan());
        }
        offset = end + 1;
        let size = usize::try_from(object.size).map_err(|_| incomplete_publication_scan())?;
        if offset + size >= bytes.len() || bytes[offset + size] != b'\n' {
            return Err(incomplete_publication_scan());
        }
        let content = &bytes[offset..offset + size];
        if object.object_type == "tree" {
            children.extend(assert_publication_tree(content, object.id.len() / 2)?);
        } else {
            if object.object_type == "commit" {
                let Some(end_of_header) = find_header_end(content) else {
                    return Err(incomplete_publication_scan());
                };
                let headers: Vec<&str> = std::str::from_utf8(&content[..end_of_header])
                    .map_err(|_| incomplete_publication_scan())?
                    .split('\n')
                    .collect();
                let root = headers.first().and_then(|line| line.strip_prefix("tree "));
                let Some(root) = root.filter(|root| root.len() == object.id.len()) else {
                    return Err(incomplete_publication_scan());
                };
                children.push(PublicationReference {
                    id: crate::core::decode::hash(root)?,
                    format_yaml: false,
                });
                for header in headers.iter().skip(1) {
                    let Some(parent) = header.strip_prefix("parent ") else {
                        continue;
                    };
                    if parent.len() != object.id.len() {
                        return Err(incomplete_publication_scan());
                    }
                    children.push(PublicationReference {
                        id: crate::core::decode::hash(parent)?,
                        format_yaml: false,
                    });
                }
            }
            assert_publication_text(content)?;
            if object.format_yaml {
                assert_publication_yaml(content)?;
            }
        }
        offset += size + 1;
    }
    if offset != bytes.len() {
        return Err(incomplete_publication_scan());
    }
    Ok(children)
}

fn find_header_end(content: &[u8]) -> Option<usize> {
    content.windows(2).position(|pair| pair == b"\n\n")
}

/// The publication scan: every tracked path and every reachable object of `head`.
pub async fn scan_publication(
    port: &dyn CommandPort,
    root: &str,
    head: &str,
) -> Result<(), GitError> {
    let scanner = Scanner { port, root };
    let shallow = scanner
        .read(
            vec!["rev-parse".to_owned(), "--is-shallow-repository".to_owned()],
            None,
            METADATA_LIMIT,
        )
        .await?;
    if String::from_utf8_lossy(&shallow).trim() != "false" {
        return Err(incomplete_publication_scan());
    }
    let mut objects: HashSet<String> = HashSet::new();
    let mut yaml_objects: HashSet<String> = HashSet::new();
    // Git's own enumeration order, kept beside the membership set: the passes below append
    // objects they discover, so the list must stay ordered and the set answers "seen?".
    let mut ids: Vec<String> = Vec::new();
    let mut yaml_ids: Vec<String> = Vec::new();
    let listing = scanner
        .read(
            vec![
                "ls-tree".to_owned(),
                "-r".to_owned(),
                "-z".to_owned(),
                head.to_owned(),
            ],
            None,
            METADATA_LIMIT,
        )
        .await?;
    for entry in crate::core::decode::nul(&listing)? {
        let Some(tab) = entry.find('\t') else {
            return Err(incomplete_publication_scan());
        };
        let header: Vec<&str> = entry[..tab].split(' ').collect();
        let [_, kind, id] = match header.as_slice() {
            [mode, kind, id] => [*mode, *kind, *id],
            _ => return Err(incomplete_publication_scan()),
        };
        let path = &entry[tab + 1..];
        if path.is_empty() || !matches!(kind, "blob" | "commit") {
            return Err(incomplete_publication_scan());
        }
        if sensitive_publication_path(path) {
            return Err(GitError::new(
                GitErrorCode::SensitivePublication,
                "Sensitive tracked path",
            ));
        }
        if kind == "blob" {
            let id = crate::core::decode::hash(id)?;
            if objects.insert(id.clone()) {
                ids.push(id.clone());
            }
            if publication_yaml_name(path) && !yaml_objects.contains(&id) {
                yaml_objects.insert(id.clone());
                yaml_ids.push(id);
            }
        }
    }
    let reachable = scanner
        .read(
            vec![
                "rev-list".to_owned(),
                "--objects".to_owned(),
                "--no-object-names".to_owned(),
                head.to_owned(),
            ],
            None,
            METADATA_LIMIT,
        )
        .await?;
    for id in String::from_utf8_lossy(&reachable).lines() {
        if !id.is_empty() {
            let id = crate::core::decode::hash(id)?;
            if objects.insert(id.clone()) {
                ids.push(id);
            }
        }
    }
    if objects.len() > OBJECT_COUNT_LIMIT {
        return Err(incomplete_publication_scan());
    }
    let mut total = 0u64;
    let mut batch: Vec<ScanObject> = Vec::new();
    let mut batch_bytes = 0u64;
    for phase_yaml in [false, true] {
        let mut position = 0usize;
        loop {
            // The live list: a tree or commit edge found in this pass appends its child, and the
            // pass reaches it instead of stopping at the list it started with. Only the batch
            // being read is copied, because the flush appends to the list it walks.
            let group: Vec<String> = {
                let live = if phase_yaml { &yaml_ids } else { &ids };
                if position >= live.len() {
                    break;
                }
                let end = live.len().min(position + 512);
                let group = live[position..end].to_vec();
                position = end;
                group
            };
            let mut input = group.join("\n");
            input.push('\n');
            let headers = scanner
                .read(
                    vec!["cat-file".to_owned(), "--batch-check".to_owned()],
                    Some(input.as_bytes()),
                    METADATA_LIMIT,
                )
                .await?;
            let header_text = String::from_utf8_lossy(&headers).into_owned();
            let lines: Vec<&str> = header_text.trim().split('\n').collect();
            if lines.len() != group.len() {
                return Err(incomplete_publication_scan());
            }
            for (index, line) in lines.iter().enumerate() {
                let mut object = object_header(line)?;
                if phase_yaml && object.object_type != "blob" {
                    return Err(incomplete_publication_scan());
                }
                if object.id != group[index] || object.size > OBJECT_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                total += object.size;
                if total > CONTENT_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                if batch.len() >= 256 || batch_bytes + object.size > 16 * 1024 * 1024 {
                    let children = scanner.flush(&mut batch, &mut batch_bytes).await?;
                    absorb(
                        children,
                        &mut objects,
                        &mut yaml_objects,
                        &mut yaml_ids,
                        &mut ids,
                    )?;
                }
                object.format_yaml = phase_yaml;
                batch_bytes += object.size + 1;
                batch.push(object);
            }
            let children = scanner.flush(&mut batch, &mut batch_bytes).await?;
            absorb(
                children,
                &mut objects,
                &mut yaml_objects,
                &mut yaml_ids,
                &mut ids,
            )?;
        }
    }
    Ok(())
}

fn absorb(
    children: Vec<PublicationReference>,
    objects: &mut HashSet<String>,
    yaml_objects: &mut HashSet<String>,
    yaml_ids: &mut Vec<String>,
    ids: &mut Vec<String>,
) -> Result<(), GitError> {
    for child in children {
        if child.format_yaml && !yaml_objects.contains(&child.id) {
            yaml_objects.insert(child.id.clone());
            yaml_ids.push(child.id.clone());
        }
        if objects.insert(child.id.clone()) {
            ids.push(child.id);
        }
        if objects.len() > OBJECT_COUNT_LIMIT {
            return Err(incomplete_publication_scan());
        }
    }
    Ok(())
}

/// The scan's reads, through the caller's command port.
struct Scanner<'a> {
    port: &'a dyn CommandPort,
    root: &'a str,
}

impl Scanner<'_> {
    async fn read(
        &self,
        args: Vec<String>,
        input: Option<&[u8]>,
        capacity: usize,
    ) -> Result<Vec<u8>, GitError> {
        let mut command = Command::owned(self.root, args)
            .with_capture_bytes(capacity)
            .with_env(&[
                ("GIT_NO_REPLACE_OBJECTS", "1"),
                ("GIT_NO_LAZY_FETCH", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GCM_INTERACTIVE", "never"),
                ("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"),
            ]);
        if let Some(input) = input {
            command = command.with_input(input);
        }
        let result = checked(self.port, command).await?;
        if result.truncated {
            return Err(incomplete_publication_scan());
        }
        Ok(result.stdout)
    }

    async fn flush(
        &self,
        batch: &mut Vec<ScanObject>,
        batch_bytes: &mut u64,
    ) -> Result<Vec<PublicationReference>, GitError> {
        if batch.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = String::new();
        for object in batch.iter() {
            input.push_str(&object.id);
            input.push('\n');
        }
        let capacity =
            usize::try_from(*batch_bytes + batch.len() as u64 * 128).unwrap_or(METADATA_LIMIT);
        let bytes = self
            .read(
                vec!["cat-file".to_owned(), "--batch".to_owned()],
                Some(input.as_bytes()),
                capacity,
            )
            .await?;
        let children = inspect_publication_batch(&bytes, batch)?;
        batch.clear();
        *batch_bytes = 0;
        Ok(children)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn classify(path: &str, content: &[u8]) -> String {
        if sensitive_publication_path(path) {
            return "sensitive_publication".to_owned();
        }
        if let Err(error) = assert_publication_text(content) {
            return error.code.as_str().to_owned();
        }
        if publication_yaml_name(path)
            && let Err(error) = assert_publication_yaml(content)
        {
            return error.code.as_str().to_owned();
        }
        "publishable".to_owned()
    }

    fn config(user: &str) -> String {
        format!("apiVersion: v1\nkind: Config\nusers:\n- name: fixture\n  user:\n{user}\n")
    }

    fn expect(path: &str, text: &str, verdict: &str) {
        assert_eq!(classify(path, text.as_bytes()), verdict, "{path}: {text:?}");
    }

    // `publication-sensitive.test.ts`: credential assignments that must block.
    #[test]
    fn credential_assignments_are_blocked() {
        for (path, text) in [
            ("config/runtime.conf", "DB_PASSWORD=opaque-value\n"),
            (
                "config/settings.toml",
                "[credentials]\n\"token\" = \"opaque-value\"\n",
            ),
            ("config/runtime.conf", "DB_PASSWORD_CURRENT=opaque-value\n"),
            (
                "config/settings.toml",
                "[credentials]\n'APP_TOKEN' = 'opaque-value'\n",
            ),
            (
                "config/settings.toml",
                "service.\"private\\u005fkey\" = \"opaque-value\"\n",
            ),
            (
                "config/runtime.conf",
                "//registry.example.invalid/:_auth=opaque-value\n",
            ),
            ("config/runtime.conf", "api_token=opaque-value\n"),
            ("config/runtime.conf", "auth=opaque-value\n"),
            ("config/runtime.conf", "private_key=opaque-value\n"),
            (
                "config/runtime.conf",
                "token_url = \"unfinished\nDB_PASSWORD=opaque-value\n",
            ),
            (
                "config/settings.json",
                "{\"api_token_url_secret\":\"opaque-value\"}\n",
            ),
            (
                "config/settings.json",
                &format!("{{\"token_url\":\"github_pat_{}\"}}\n", "a".repeat(32)),
            ),
            (
                "config/settings.json",
                &format!("{{\"ghp_{}\":\"\"}}\n", "a".repeat(32)),
            ),
            (
                "config/settings.json",
                "{\"token_file\":\"-----BEGIN PRIVATE KEY-----\\nsynthetic\\n-----END PRIVATE KEY-----\"}\n",
            ),
            (
                "config/runtime.conf",
                "https://octo:opaque-value@example.invalid\n",
            ),
            (
                "config/runtime.conf",
                "DB_PASSWORD=\"\"\napi_token=opaque-value\n",
            ),
            ("config/runtime.conf", "DB_PASSWORD=\"\"opaque-value\n"),
        ] {
            expect(path, text, "sensitive_publication");
        }
    }

    // The same file's ordinary samples, which must publish.
    #[test]
    fn ordinary_settings_publish() {
        for (path, text) in [
            (
                "config/runtime.conf",
                "DB_HOST=example.invalid\nRETRY_COUNT=3\n",
            ),
            (
                "config/settings.toml",
                "[settings]\n\"host\" = \"example.invalid\"\n",
            ),
            (
                "config/runtime.conf",
                "password_min_length = 8\ntoken_url = \"https://example.invalid\"\n",
            ),
            (
                "config/runtime.conf",
                "api_token_endpoint = \"https://example.invalid\"\nprivate_key_path = \"local/key\"\npassword_file = \"local/pass\"\ntoken_expiry = 120\ntoken_ttl = 60\npassword_max_length = 100\npasswordMinLength = 8\n",
            ),
            (
                "config/settings.toml",
                "[settings]\n\"password_min_length\" = 8\n\"token_url\" = \"https://example.invalid\"\nauth.token_endpoint = \"https://example.invalid\"\n",
            ),
            (
                "config/settings.json",
                "{\"token_url\":\"https://example.invalid\"}\n",
            ),
            (
                "config/settings.yaml",
                "\"token_url\": \"https://example.invalid\"\n",
            ),
            ("config/runtime.conf", "DB_PASSWORD=\"\"\nAPI_TOKEN=''\n"),
            (
                "config/settings.toml",
                "[settings]\n\"token\" = \"\"\n'password' = ''\n\"tok\\u0065n\" = \"\"\n",
            ),
            ("config/settings.json", "{\"password\":\"\"}\n"),
            ("config/settings.yaml", "\"password\": \"\"\n'token': ''\n"),
        ] {
            expect(path, text, "publishable");
        }
    }

    #[test]
    fn many_short_assignments_and_long_values_are_handled_within_their_budgets() {
        expect(
            "config/runtime.conf",
            &"a . a\n".repeat(10_000),
            "publishable",
        );
        let text = format!(
            "banner = \"{}\"\nexample = {}\n",
            "a".repeat(20_000),
            "a".repeat(20_000)
        );
        expect("config/runtime.conf", &text, "publishable");
        for text in [
            "a . ".repeat(50_000),
            "a".repeat(16_385),
            format!("\"{}\"", "a".repeat(16_385)),
        ] {
            expect("config/runtime.conf", &text, "publication_scan_incomplete");
        }
    }

    // The same file's YAML credential cases.
    #[test]
    fn yaml_credential_fields_are_blocked() {
        let samples = [
            (
                "deploy/settings.yaml",
                "auths:\n  registry.example.invalid:\n    'auth': c3ludGhldGljOmNyZWRlbnRpYWw=\n"
                    .to_owned(),
            ),
            (
                "deploy/settings.yaml",
                "'private_key': 'opaque-value'\n".to_owned(),
            ),
            (
                "deploy/kubeconfig.yaml",
                config("    'token': opaque-value"),
            ),
            (
                "deploy/KUBECONFIG.production.yml",
                config("    'token': opaque-value"),
            ),
            ("deploy/cluster.yaml", config("    'token': opaque-value")),
            ("deploy/cluster.yaml", config("    \"token\": opaque-value")),
            ("deploy/cluster.yaml", config("    token: opaque-value")),
            (
                "deploy/cluster.yaml",
                config("    \"t\\u006fken\": opaque-value"),
            ),
            (
                "deploy/cluster.yaml",
                config("    'client-key-data': b3BhcXVlLXZhbHVl"),
            ),
            (
                "deploy/cluster.yaml",
                config("    'client-certificate-data': b3BhcXVlLXZhbHVl"),
            ),
            (
                "deploy/cluster.yaml",
                config("    'password': opaque-value"),
            ),
            (
                "deploy/cluster.yaml",
                config(
                    "    'auth-provider':\n      name: opaque-provider\n      config:\n        cached: opaque-value",
                ),
            ),
            (
                "deploy/cluster.yaml",
                config(
                    "    'exec':\n      command: credential-helper\n      'env':\n      - name: OPAQUE_AUTH\n        value: opaque-value",
                ),
            ),
        ];
        for (path, text) in samples {
            expect(path, &text, "sensitive_publication");
        }
    }

    #[test]
    fn uninspectable_yaml_fails_closed_and_plain_yaml_publishes() {
        let depth: String = (0..66)
            .map(|index| format!("{}value:\n", "  ".repeat(index)))
            .collect();
        let nodes = format!("values:\n{}", "- safe\n".repeat(100_001));
        let documents = "---\nvalue: safe\n".repeat(21);
        for text in [
            "settings: [broken".to_owned(),
            "base: &base {value: safe}\ncopy: *base\n".to_owned(),
            "value: !opaque safe\n".to_owned(),
            format!("#{}", "a".repeat(1024 * 1024)),
            depth,
            nodes,
            documents,
        ] {
            expect("deploy/settings.yaml", &text, "publication_scan_incomplete");
        }
        expect(
            "deploy/settings.yaml",
            "apiVersion: v1\nkind: Config\ncontexts: []\nusers: []\n",
            "publishable",
        );
        expect(
            "deploy/settings.YML",
            "settings: [broken",
            "publication_scan_incomplete",
        );
        expect("deploy/settings.txt", "settings: [broken", "publishable");
    }

    // The same file's sensitive paths and literal secrets.
    #[test]
    fn sensitive_paths_and_literal_secrets_are_blocked() {
        for (path, text) in [
            (".env.production", "setting=value"),
            ("config/credentials.json", "{}"),
            (
                "notes.txt",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----",
            ),
            ("src/config.txt", &format!("ghp_{}", "x".repeat(32))),
            ("archive.bin", "\0Bearer synthetic-private-value\0"),
            (
                "docs/link.txt",
                "https://example.invalid/#ticket=opaque-credential",
            ),
            (
                ".docker/config.json",
                "{\"auths\":{\"registry.example.invalid\":{\"auth\":\"c3ludGhldGljOmNyZWRlbnRpYWw=\"}}}",
            ),
            (
                "registry.json",
                "{\"auths\":{\"registry.example.invalid\":{\"a\\u0075th\":\"c3ludGhldGljOmNyZWRlbnRpYWw=\"}}}",
            ),
            (".npmrc", "//registry.example.invalid/:_authToken=synthetic"),
            (
                "copied-config.txt",
                "//registry.example.invalid/:_authToken=synthetic",
            ),
            (".pypirc", "[index-server]\npassword = synthetic"),
            (
                ".netrc",
                "machine example.invalid login synthetic password synthetic",
            ),
            (
                ".git-credentials",
                "https://synthetic:synthetic@example.invalid",
            ),
            (
                ".aws/credentials",
                "[default]\naws_secret_access_key=synthetic",
            ),
            (".azure/msal_token_cache.bin", "synthetic"),
            (".config/gcloud/access_tokens.db", "synthetic"),
            (
                "copied-cloud.json",
                "{\"profile\":{\"aws_access_key_id\":\"synthetic\"}}",
            ),
        ] {
            expect(path, text, "sensitive_publication");
        }
        expect(
            "asset.bin",
            "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
            "publication_scan_incomplete",
        );
    }

    #[tokio::test]
    async fn a_scan_reads_every_tracked_path_and_reachable_object() {
        let fixture = Fixture::new("g3d-scan");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        std::fs::write(repo.join("safe.txt"), "nothing secret\n").expect("safe");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "safe"]);
        let port = ProcessCommands { fixture: &fixture };
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        scan_publication(&port, &repo.to_string_lossy(), &head)
            .await
            .expect("safe scan");

        // A token in a reachable blob is found even in history.
        std::fs::write(repo.join("leak.txt"), format!("ghp_{}", "x".repeat(32))).expect("leak");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "leak"]);
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let error = scan_publication(&port, &repo.to_string_lossy(), &head)
            .await
            .expect_err("leak");
        assert_eq!(error.code, GitErrorCode::SensitivePublication);
    }

    #[tokio::test]
    async fn a_shallow_checkout_and_a_sensitive_path_fail_before_a_read() {
        let fixture = Fixture::new("g3d-scan-paths");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        std::fs::create_dir_all(repo.join("config")).expect("dir");
        std::fs::write(repo.join("config/credentials.json"), "{}").expect("credentials");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "credentials"]);
        let port = ProcessCommands { fixture: &fixture };
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let error = scan_publication(&port, &repo.to_string_lossy(), &head)
            .await
            .expect_err("path");
        assert_eq!(error.code, GitErrorCode::SensitivePublication);
    }
}

#[cfg(test)]
mod scan_order_tests {
    use super::*;
    use crate::core::spawn::BoxFuture;
    use crate::reads::{Command, CommandOutput, CommandPort};

    const TREE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BLOB: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SECRET: &[u8] = b"password=hunter2\n";

    /// A port that scripts the scan: `rev-list` never names the tree's child, so only a live
    /// pass over the growing id list ever inspects the blob the tree points at.
    struct TreeThenBlob;

    impl TreeThenBlob {
        fn hex(sha: &str) -> Vec<u8> {
            (0..sha.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&sha[index..index + 2], 16).unwrap_or(0))
                .collect()
        }

        fn tree() -> Vec<u8> {
            // A name publication accepts, so only the blob's own bytes can refuse the scan.
            let mut tree = b"100644 notes.txt\0".to_vec();
            tree.extend(Self::hex(BLOB));
            tree
        }
    }

    impl CommandPort for TreeThenBlob {
        fn run(&self, command: Command) -> BoxFuture<'_, Result<CommandOutput, GitError>> {
            Box::pin(async move {
                let output = |stdout: Vec<u8>| CommandOutput {
                    stdout,
                    stderr: String::new(),
                    exit_code: 0,
                    truncated: false,
                    stopped: None,
                };
                let first = command.args.first().map(String::as_str).unwrap_or_default();
                match (first, command.args.get(1).map(String::as_str)) {
                    ("rev-parse", _) => Ok(output(b"false\n".to_vec())),
                    ("ls-tree", _) => Ok(output(Vec::new())),
                    ("rev-list", _) => Ok(output(format!("{TREE}\n").into_bytes())),
                    ("cat-file", Some("--batch-check")) => {
                        let input =
                            String::from_utf8_lossy(command.input.as_deref().unwrap_or(b""))
                                .into_owned();
                        let mut body = String::new();
                        for line in input.lines() {
                            if line == TREE {
                                body.push_str(&format!("{TREE} tree {}\n", Self::tree().len()));
                            } else if line == BLOB {
                                body.push_str(&format!("{BLOB} blob {}\n", SECRET.len()));
                            } else {
                                body.push_str(&format!("{line} blob 1\n"));
                            }
                        }
                        Ok(output(body.into_bytes()))
                    }
                    ("cat-file", Some("--batch")) => {
                        let input =
                            String::from_utf8_lossy(command.input.as_deref().unwrap_or(b""))
                                .into_owned();
                        let tree = Self::tree();
                        let mut body = Vec::new();
                        for line in input.lines() {
                            if line == TREE {
                                body.extend(format!("{TREE} tree {}\n", tree.len()).into_bytes());
                                body.extend(&tree);
                                body.push(b'\n');
                            } else if line == BLOB {
                                body.extend(format!("{BLOB} blob {}\n", SECRET.len()).into_bytes());
                                body.extend(SECRET);
                                body.push(b'\n');
                            }
                        }
                        Ok(output(body))
                    }
                    _ => Err(GitError::new(
                        GitErrorCode::GitFailed,
                        "unexpected scan command",
                    )),
                }
            })
        }
    }

    // `publication-scan.ts:100-104`: the pass walks the live id list, so an object found through
    // a tree edge is inspected in the same pass.
    #[tokio::test]
    async fn an_object_found_through_a_tree_edge_is_credential_scanned_in_the_same_pass() {
        let error = scan_publication(&TreeThenBlob, "/repo", "HEAD")
            .await
            .expect_err("the tree's child holds a credential");
        assert_eq!(error.code, GitErrorCode::SensitivePublication, "{error:?}");
        // Not the tree entry's name: the blob's content is what the live pass reaches.
        assert_eq!(error.message, "Sensitive publication content");
    }
}
