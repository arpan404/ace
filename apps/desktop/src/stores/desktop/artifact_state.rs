use super::ArtifactItemProjection;
use ace_core::ThreadId;

pub(super) fn parse_artifact_items(
    thread_id: &ThreadId,
    message_id: &str,
    value: &serde_json::Value,
    observed_at: &str,
    fallback_title: Option<&str>,
    fallback_url: Option<&str>,
) -> Vec<ArtifactItemProjection> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                parse_artifact_item(
                    thread_id,
                    message_id,
                    item,
                    index,
                    observed_at,
                    fallback_title,
                    fallback_url,
                )
            })
            .collect(),
        _ => parse_artifact_item(
            thread_id,
            message_id,
            value,
            0,
            observed_at,
            fallback_title,
            fallback_url,
        )
        .into_iter()
        .collect(),
    }
}

fn parse_artifact_item(
    thread_id: &ThreadId,
    message_id: &str,
    value: &serde_json::Value,
    index: usize,
    observed_at: &str,
    fallback_title: Option<&str>,
    fallback_url: Option<&str>,
) -> Option<ArtifactItemProjection> {
    let (kind, title, url, path, mime_type) = match value {
        serde_json::Value::String(value) => {
            let title = value
                .rsplit(['/', '\\'])
                .next()
                .filter(|part| !part.is_empty())
                .unwrap_or("Attachment")
                .to_string();
            let url = value.contains("://").then(|| value.clone());
            let path = (!value.contains("://")).then(|| value.clone());
            ("artifact".to_string(), title, url, path, None)
        }
        serde_json::Value::Object(object) => {
            let url = string_field(object, &["url", "src", "href"]);
            let path = string_field(object, &["path", "file", "relative_path", "relativePath"]);
            let mime_type = string_field(object, &["mime_type", "mimeType", "contentType"]);
            let kind = string_field(object, &["kind", "type"])
                .or_else(|| artifact_kind_from_mime(mime_type.as_deref()).map(ToString::to_string))
                .unwrap_or_else(|| "artifact".to_string());
            let title = string_field(object, &["title", "name", "filename", "file_name"])
                .or_else(|| {
                    path.as_deref()
                        .or(url.as_deref())
                        .and_then(|value| value.rsplit(['/', '\\']).next())
                        .filter(|part| !part.is_empty())
                        .map(ToString::to_string)
                })
                .or_else(|| fallback_title.map(ToString::to_string))
                .unwrap_or_else(|| format!("Artifact {}", index + 1));
            (kind, title, url, path, mime_type)
        }
        _ => return None,
    };

    let url = url.or_else(|| fallback_url.map(ToString::to_string));
    let location = path
        .as_deref()
        .or(url.as_deref())
        .unwrap_or("provider attachment");
    let mime = mime_type
        .as_deref()
        .map(|mime| format!(" · {mime}"))
        .unwrap_or_default();
    Some(ArtifactItemProjection {
        id: format!("{message_id}:{index}"),
        thread_id: thread_id.clone(),
        message_id: message_id.to_string(),
        kind: kind.clone(),
        title,
        detail: format!("{kind} · {location}{mime}"),
        url,
        path,
        mime_type,
        observed_at: observed_at.to_string(),
    })
}

fn artifact_kind_from_mime(mime_type: Option<&str>) -> Option<&'static str> {
    let mime_type = mime_type?;
    if mime_type.starts_with("image/") {
        Some("image")
    } else if mime_type.starts_with("audio/") {
        Some("audio")
    } else if mime_type == "application/pdf" || mime_type.starts_with("text/") {
        Some("document")
    } else {
        None
    }
}

fn string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_array_artifacts_and_infers_media_kind_from_mime() {
        let artifacts = parse_artifact_items(
            &ThreadId("thread-1".to_string()),
            "message-1",
            &serde_json::json!([
                {
                    "title": "Login screenshot",
                    "url": "codex://attachment/login.png",
                    "mimeType": "image/png"
                },
                {
                    "path": "reports/run.pdf",
                    "mime_type": "application/pdf"
                }
            ]),
            "42",
            None,
            None,
        );

        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].id, "message-1:0");
        assert_eq!(artifacts[0].kind, "image");
        assert_eq!(artifacts[0].title, "Login screenshot");
        assert_eq!(
            artifacts[0].url.as_deref(),
            Some("codex://attachment/login.png")
        );
        assert_eq!(artifacts[0].observed_at, "42");
        assert_eq!(artifacts[1].kind, "document");
        assert_eq!(artifacts[1].title, "run.pdf");
        assert_eq!(artifacts[1].path.as_deref(), Some("reports/run.pdf"));
    }

    #[test]
    fn parses_string_artifact_as_url_or_path() {
        let url_artifact = parse_artifact_items(
            &ThreadId("thread-1".to_string()),
            "message-2",
            &serde_json::json!("https://example.test/out.png"),
            "7",
            None,
            None,
        );
        let path_artifact = parse_artifact_items(
            &ThreadId("thread-1".to_string()),
            "message-3",
            &serde_json::json!("target/report.txt"),
            "8",
            None,
            None,
        );

        assert_eq!(url_artifact[0].title, "out.png");
        assert_eq!(
            url_artifact[0].url.as_deref(),
            Some("https://example.test/out.png")
        );
        assert_eq!(path_artifact[0].title, "report.txt");
        assert_eq!(path_artifact[0].path.as_deref(), Some("target/report.txt"));
    }

    #[test]
    fn falls_back_to_thread_item_title_and_url_for_sparse_object() {
        let artifacts = parse_artifact_items(
            &ThreadId("thread-1".to_string()),
            "message-4",
            &serde_json::json!({ "kind": "artifact" }),
            "9",
            Some("Generated report"),
            Some("codex://attachment/report.pdf"),
        );

        assert_eq!(artifacts[0].title, "Generated report");
        assert_eq!(
            artifacts[0].url.as_deref(),
            Some("codex://attachment/report.pdf")
        );
        assert!(
            artifacts[0]
                .detail
                .contains("codex://attachment/report.pdf")
        );
    }
}
