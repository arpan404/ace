// SPDX-License-Identifier: Apache-2.0
//! The YAML credential walk (`publication-yaml.ts`, G3d): parsed nodes without converting or
//! expanding aliases, so unknown tags, aliases and duplicate keys fail closed.

use std::collections::HashSet;

use yaml_rust2::parser::{Event, Parser, Tag};
use yaml_rust2::scanner::TScalarStyle;

use crate::core::error::{GitError, GitErrorCode};

use super::credentials::{CredentialValue, has_sensitive_span, is_publication_credential_key};
use super::{YAML_BYTE_LIMIT, YAML_DEPTH_LIMIT, YAML_DOCUMENT_LIMIT, YAML_NODE_LIMIT};

fn yaml_incomplete() -> GitError {
    GitError::new(
        GitErrorCode::PublicationScanIncomplete,
        "YAML credential scan incomplete",
    )
}

fn allowed_tag(tag: Option<&Tag>) -> bool {
    let Some(tag) = tag else {
        return true;
    };
    let full = if tag.handle == "!" {
        format!("!{}", tag.suffix)
    } else if tag.handle == "!!" {
        format!("tag:yaml.org,2002:{}", tag.suffix)
    } else {
        format!("{}{}", tag.handle, tag.suffix)
    };
    matches!(
        full.as_str(),
        "tag:yaml.org,2002:str"
            | "tag:yaml.org,2002:int"
            | "tag:yaml.org,2002:float"
            | "tag:yaml.org,2002:bool"
            | "tag:yaml.org,2002:null"
            | "tag:yaml.org,2002:map"
            | "tag:yaml.org,2002:seq"
    )
}

/// `populated` is false for a YAML null and for the empty string: a plain `null`/`~` (or one
/// tagged `!!null`) resolves to nothing, and `""` is no value either. Quoted, `"null"` is the
/// text `null`, so it is a value like any other and blocks publication.
fn is_empty_value(text: &str, style: TScalarStyle, tag: Option<&Tag>) -> bool {
    if text.is_empty() {
        return true;
    }
    if tag.is_some_and(|tag| {
        tag.suffix == "null" && matches!(tag.handle.as_str(), "!!" | "tag:yaml.org,2002:")
    }) {
        return true;
    }
    style == TScalarStyle::Plain && matches!(text, "~" | "null" | "Null" | "NULL")
}

#[derive(Debug)]
enum Frame {
    Mapping {
        keys: HashSet<String>,
        expecting_key: bool,
        exec: bool,
        credential: Option<CredentialValue>,
    },
    Sequence {
        credential: Option<CredentialValue>,
    },
}

enum Pending {
    None,
    Credential,
    ExecEnv,
    ExecMap,
}

impl Pending {
    fn credential(&self) -> Option<CredentialValue> {
        match self {
            Self::Credential => Some(CredentialValue::Field),
            Self::ExecEnv => Some(CredentialValue::ExecEnv),
            _ => None,
        }
    }
}

/// `assertPublicationYaml`: walk parsed nodes without converting or expanding aliases.
pub fn assert_publication_yaml(bytes: &[u8]) -> Result<(), GitError> {
    if bytes.len() > YAML_BYTE_LIMIT {
        return Err(yaml_incomplete());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| yaml_incomplete())?;
    let mut parser = Parser::new_from_str(text);
    let mut frames: Vec<Frame> = Vec::new();
    let mut documents = 0usize;
    let mut nodes = 0usize;
    let mut pending = Pending::None;
    loop {
        let (event, _) = match parser.next_token() {
            Ok(event) => event,
            Err(_) => return Err(yaml_incomplete()),
        };
        if matches!(event, Event::StreamEnd | Event::Nothing) {
            break;
        }
        // A collection that is a credential's value is populated as soon as it holds anything.
        if let Some(credential) = frames.last().and_then(is_credential_value_frame)
            && !matches!(event, Event::MappingEnd | Event::SequenceEnd)
        {
            return Err(credential.sensitive());
        }
        match event {
            Event::StreamStart => {}
            Event::DocumentStart => {
                documents += 1;
                if documents > YAML_DOCUMENT_LIMIT {
                    return Err(yaml_incomplete());
                }
                frames.clear();
                pending = Pending::None;
            }
            Event::DocumentEnd => {
                frames.clear();
                pending = Pending::None;
            }
            Event::Alias(_) => return Err(yaml_incomplete()),
            Event::Scalar(value, style, _, tag) => {
                nodes += 1;
                if nodes > YAML_NODE_LIMIT || !allowed_tag(tag.as_ref()) {
                    return Err(yaml_incomplete());
                }
                if let Some(Frame::Mapping {
                    keys,
                    expecting_key,
                    exec,
                    ..
                }) = frames.last_mut()
                    && *expecting_key
                {
                    if !keys.insert(value.clone()) {
                        return Err(yaml_incomplete());
                    }
                    *expecting_key = false;
                    let lowered = value.to_ascii_lowercase();
                    pending = if is_publication_credential_key(&value) {
                        Pending::Credential
                    } else if lowered == "exec" {
                        Pending::ExecMap
                    } else if *exec && lowered == "env" {
                        Pending::ExecEnv
                    } else {
                        Pending::None
                    };
                    continue;
                }
                if let Pending::Credential | Pending::ExecEnv = pending
                    && !is_empty_value(&value, style, tag.as_ref())
                {
                    return Err(if matches!(pending, Pending::Credential) {
                        CredentialValue::Field.sensitive()
                    } else {
                        CredentialValue::ExecEnv.sensitive()
                    });
                }
                if has_sensitive_span(&value) {
                    return Err(GitError::new(
                        GitErrorCode::SensitivePublication,
                        "Sensitive YAML scalar",
                    ));
                }
                pending = Pending::None;
                mark_value_done(&mut frames);
            }
            Event::SequenceStart(_, tag) => {
                nodes += 1;
                if nodes > YAML_NODE_LIMIT || !allowed_tag(tag.as_ref()) {
                    return Err(yaml_incomplete());
                }
                if frames.len() > YAML_DEPTH_LIMIT {
                    return Err(yaml_incomplete());
                }
                if frames.last().is_some_and(|frame| {
                    matches!(
                        frame,
                        Frame::Mapping {
                            expecting_key: true,
                            ..
                        }
                    )
                }) {
                    return Err(yaml_incomplete());
                }
                let credential = pending.credential();
                pending = Pending::None;
                frames.push(Frame::Sequence { credential });
            }
            Event::MappingStart(_, tag) => {
                nodes += 1;
                if nodes > YAML_NODE_LIMIT || !allowed_tag(tag.as_ref()) {
                    return Err(yaml_incomplete());
                }
                if frames.len() > YAML_DEPTH_LIMIT {
                    return Err(yaml_incomplete());
                }
                if frames.last().is_some_and(|frame| {
                    matches!(
                        frame,
                        Frame::Mapping {
                            expecting_key: true,
                            ..
                        }
                    )
                }) {
                    return Err(yaml_incomplete());
                }
                let credential = pending.credential();
                let exec = matches!(pending, Pending::ExecMap);
                pending = Pending::None;
                frames.push(Frame::Mapping {
                    keys: HashSet::new(),
                    expecting_key: true,
                    exec,
                    credential,
                });
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let Some(frame) = frames.pop() else {
                    return Err(yaml_incomplete());
                };
                // An empty credential collection is not a value at all.
                let _ = is_credential_value_frame(&frame);
                mark_value_done(&mut frames);
            }
            Event::StreamEnd | Event::Nothing => break,
        }
    }
    Ok(())
}

fn mark_value_done(frames: &mut [Frame]) {
    if let Some(Frame::Mapping { expecting_key, .. }) = frames.last_mut() {
        *expecting_key = true;
    }
}

fn is_credential_value_frame(frame: &Frame) -> Option<CredentialValue> {
    match frame {
        Frame::Mapping { credential, .. } | Frame::Sequence { credential } => *credential,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::GitErrorCode;

    #[test]
    fn credential_fields_exec_env_and_scalars_carry_their_pinned_messages() {
        for (yaml, message) in [
            ("password: hunter2\n", "Sensitive YAML credential field"),
            (
                "steps:\n- exec:\n    env:\n      API_KEY: x\n",
                "Sensitive YAML exec environment",
            ),
            ("note: password=hunter2\n", "Sensitive YAML scalar"),
            ("password: \"null\"\n", "Sensitive YAML credential field"),
        ] {
            let error = assert_publication_yaml(yaml.as_bytes()).expect_err(yaml);
            assert_eq!(error.code, GitErrorCode::SensitivePublication);
            assert_eq!(error.message, message);
        }
        let incomplete = assert_publication_yaml(b"key: *anchor\n").expect_err("alias");
        assert_eq!(incomplete.message, "YAML credential scan incomplete");
    }

    #[test]
    fn a_yaml_null_is_not_a_value_and_a_quoted_null_is() {
        // The loader resolves these to nothing: an empty credential field is not populated.
        for yaml in [
            "password:\n",
            "password: ~\n",
            "password: null\n",
            "password: Null\n",
            "password: NULL\n",
            "password: !!null ''\n",
            "users:\n- user:\n    'token':\n",
        ] {
            assert!(assert_publication_yaml(yaml.as_bytes()).is_ok(), "{yaml:?}");
        }
        // Quoted, the same bytes are a string and populated, so the field-specific message wins.
        for yaml in ["password: \"null\"\n", "password: '~'\n", "password: ' '\n"] {
            let error = assert_publication_yaml(yaml.as_bytes()).expect_err(yaml);
            assert_eq!(error.message, "Sensitive YAML credential field", "{yaml:?}");
        }
        // The empty string is no value in any style.
        for yaml in [
            "password: \"\"\n",
            "password: ''\n",
            "users:\n- user:\n    'token': \"\"\n",
        ] {
            assert!(assert_publication_yaml(yaml.as_bytes()).is_ok(), "{yaml:?}");
        }
    }
}
