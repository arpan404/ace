// SPDX-License-Identifier: Apache-2.0
//! The input ACP is sent: the prompts one send becomes and the parts inside them
//! (`packages/commands/src/native-command-inputs.ts:3`, `packages/adapter-acp/src/content.ts:85`).

use ace_adapter_api::util::base64_data_url;
use ace_json::{JsString, Map, Value};

use crate::translate::data::{object, string};

/// The prompts one send becomes (`native-command-inputs.ts:3`): a slash command in the
/// input becomes one prompt per command, each carrying the same message context, with
/// the mention replaced by its label. Input without a command stays one prompt.
pub fn native_command_inputs(input: &[Value]) -> Result<Vec<Value>, String> {
    let mut commands: Vec<String> = Vec::new();
    let mut context: Vec<Value> = Vec::with_capacity(input.len());
    for part in input {
        let map = object(part);
        if string(map.get("type").unwrap_or(&Value::Null)) != "mention" {
            context.push(part.clone());
            continue;
        }
        let invocation = object(map.get("invocation").unwrap_or(&Value::Null));
        if string(invocation.get("type").unwrap_or(&Value::Null)) != "slash" {
            return Err("Unresolved command mention".to_owned());
        }
        let name = string(invocation.get("name").unwrap_or(&Value::Null));
        let arguments = map.get("arguments").and_then(Value::as_str).unwrap_or("");
        commands.push(if arguments.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {arguments}")
        });
        // The command's own label stays in the message beside its context.
        append_text(
            &mut context,
            &format!("[{}]", string(map.get("name").unwrap_or(&Value::Null))),
        );
    }
    if commands.is_empty() {
        return Ok(vec![Value::Array(input.to_vec().into())]);
    }
    Ok(commands
        .into_iter()
        .map(|command| {
            let mut parts = Vec::with_capacity(context.len() + 1);
            parts.push(text(&format!("{command}\n\nMessage context:\n")));
            parts.extend(context.iter().cloned());
            Value::Array(parts.into())
        })
        .collect())
}

/// Appends to a trailing text part, or starts one (`native-command-inputs.ts:13`-`:16`).
fn append_text(context: &mut Vec<Value>, more: &str) {
    if let Some(Value::Object(last)) = context.last_mut()
        && string(last.get("type").unwrap_or(&Value::Null)) == "text"
        && let Some(Value::String(existing)) = last.get("text")
    {
        let mut text_value = existing.clone();
        text_value.push_str(more);
        last.insert("text", Value::String(text_value));
        return;
    }
    context.push(text(more));
}

fn text(value: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type", Value::from("text"));
    map.insert("text", Value::from(value));
    Value::Object(map)
}

/// One `ContentPart` as ACP carries it (`content.ts:85`). A mention that never resolved,
/// and an image that is not inline base64, refuse the whole send unsent.
pub fn encode_content(part: &Value) -> Result<Value, String> {
    let map = object(part);
    let kind = string(map.get("type").unwrap_or(&Value::Null));
    match kind {
        "mention" => Err("Unresolved ACP mention".to_owned()),
        "text" => Ok(part.clone()),
        "file" => encode_file(map),
        _ => encode_image(map),
    }
}

fn encode_file(map: &Map) -> Result<Value, String> {
    let path = map.get("path").and_then(Value::as_str).unwrap_or("");
    let uri = path_to_file_url(path);
    let mime = map.get("mimeType").and_then(Value::as_str);
    let mut out = Map::with_capacity(3);
    if let Some(content) = map.get("content").and_then(Value::as_object) {
        let mut resource = Map::with_capacity(4);
        resource.insert("uri", Value::from(uri));
        resource.insert(
            "mimeType",
            Value::from(mime.unwrap_or("application/octet-stream")),
        );
        let data = content.get("data").cloned().unwrap_or(Value::Null);
        let encoding = content.get("encoding").and_then(Value::as_str);
        resource.insert(
            if encoding == Some("text") {
                "text"
            } else {
                "blob"
            },
            data,
        );
        out.insert("type", Value::from("resource"));
        out.insert("resource", Value::Object(resource));
        return Ok(Value::Object(out));
    }
    out.insert("type", Value::from("resource_link"));
    out.insert("uri", Value::from(uri));
    out.insert("name", Value::from(file_name(path)));
    if let Some(mime) = mime {
        out.insert("mimeType", Value::from(mime));
    }
    Ok(Value::Object(out))
}

fn encode_image(map: &Map) -> Result<Value, String> {
    let url = map.get("url").and_then(Value::as_str).unwrap_or("");
    let Some(image) = base64_data_url(url) else {
        return Err("ACP image input requires a base64 data URL".to_owned());
    };
    let mut out = Map::with_capacity(3);
    out.insert("type", Value::from("image"));
    // `mimeType: part.mimeType`: absent stays absent, as JSON.stringify drops undefined
    // (`content.ts:111`). ACP requires one, but guessing was never TS's answer.
    if let Some(mime) = map.get("mimeType").and_then(Value::as_str) {
        out.insert("mimeType", Value::from(mime));
    }
    out.insert("data", Value::from(image.data));
    Ok(Value::Object(out))
}

/// The file's own name (`path.split("/").at(-1) ?? path`, `content.ts:106`): whole, as
/// TS sends it.
fn file_name(path: &str) -> JsString {
    JsString::from(path.rsplit(['/', '\\']).next().unwrap_or(path))
}

/// `pathToFileURL(path).href` (`node:url`): an absolute path as a `file://` URL.
///
/// What Node leaves alone it leaves alone here: the URL path percent-encode set (controls,
/// space, `"`, `#`, `<`, `>`, `?`, `` ` ``, `{`, `}`) and the bytes Node's own
/// `encodePathChars` escapes (`%`, `\\`, tab, newline, carriage return) are encoded; `(`,
/// `)`, `+`, `@`, `!`, `=`, `,`, `&`, `'`, `$`, `;`, `[`, `]` and the rest of a path stay as
/// they are, and non-ASCII travels as UTF-8 percent-encoded bytes. A Windows drive stays in
/// the path and a UNC share becomes the URL's host.
pub fn path_to_file_url(path: &str) -> String {
    let (host, path) = windows_host_and_path(path);
    let mut url = String::with_capacity(path.len() + host.len() + 8);
    url.push_str("file://");
    url.push_str(&host);
    if !path.starts_with('/') {
        url.push('/');
    }
    url.push_str(&encode_path(&path));
    url
}

/// A Windows path's host and URL path: `C:\\a` keeps its drive in the path, `\\\\server\\share`
/// makes the server the host.
fn windows_host_and_path(path: &str) -> (String, String) {
    let bytes = path.as_bytes();
    if bytes.len() > 1 && bytes[0] == b'\\' && (bytes[1] == b'\\' || bytes[1] == b'/') {
        let rest = &path[2..];
        return match rest.find(['\\', '/']) {
            Some(index) => (
                rest[..index].to_owned(),
                format!("/{}", rest[index + 1..].replace('\\', "/")),
            ),
            None => (rest.to_owned(), "/".to_owned()),
        };
    }
    let drive = bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    if drive {
        return (String::new(), path.replace('\\', "/"));
    }
    (String::new(), path.to_owned())
}

fn encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        let keep = byte > 0x20
            && byte < 0x7f
            && !matches!(
                byte,
                b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}' | b'%' | b'\\' | b'^' | b'|'
            );
        if keep {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{encode_content, native_command_inputs, path_to_file_url};
    use ace_json::{Value, json};

    #[test]
    fn a_slash_command_becomes_one_prompt_per_command_over_the_same_context() {
        let input = json!([
            { "type": "text", "text": "run this" },
            { "type": "mention", "name": "review", "arguments": "strict",
              "invocation": { "type": "slash", "name": "review" } },
            { "type": "text", "text": "please" }
        ]);
        let prompts =
            native_command_inputs(input.as_array().map(|parts| &parts[..]).unwrap_or(&[]));
        let Ok(prompts) = prompts else {
            panic!("expected the command input to split");
        };
        assert_eq!(prompts.len(), 1);
        let parts = prompts[0].as_array().cloned().unwrap_or_default();
        assert_eq!(
            parts[0].get("text").and_then(Value::as_str),
            Some("/review strict\n\nMessage context:\n")
        );
        // The mention's label joins the text part before it.
        assert_eq!(
            parts[1].get("text").and_then(Value::as_str),
            Some("run this[review]")
        );
        assert_eq!(parts[2].get("text").and_then(Value::as_str), Some("please"));
    }

    #[test]
    fn input_without_a_command_is_one_prompt_and_an_unresolved_mention_refuses() {
        let plain = json!([{ "type": "text", "text": "hello" }]);
        assert_eq!(
            native_command_inputs(plain.as_array().map(|parts| &parts[..]).unwrap_or(&[])),
            Ok(vec![plain.clone()])
        );
        let unresolved =
            json!([{ "type": "mention", "name": "x", "invocation": { "type": "skill" } }]);
        assert_eq!(
            native_command_inputs(unresolved.as_array().map(|parts| &parts[..]).unwrap_or(&[])),
            Err("Unresolved command mention".to_owned())
        );
    }

    #[test]
    fn parts_encode_to_the_resource_link_resource_and_image_shapes() {
        let text = json!({ "type": "text", "text": "hi" });
        assert_eq!(encode_content(&text), Ok(text.clone()));

        let link = json!({ "type": "file", "path": "/work/a b.ts", "mimeType": "text/plain" });
        assert_eq!(
            encode_content(&link),
            Ok(json!({
                "type": "resource_link",
                "uri": "file:///work/a%20b.ts",
                "name": "a b.ts",
                "mimeType": "text/plain"
            }))
        );

        let resource = json!({
            "type": "file", "path": "/work/a.ts",
            "content": { "encoding": "text", "data": "let a = 1;" }
        });
        assert_eq!(
            encode_content(&resource),
            Ok(json!({
                "type": "resource",
                "resource": {
                    "uri": "file:///work/a.ts",
                    "mimeType": "application/octet-stream",
                    "text": "let a = 1;"
                }
            }))
        );

        let image = json!({
            "type": "image",
            "mimeType": "image/png",
            "url": "data:image/png;base64,AAAA"
        });
        assert_eq!(
            encode_content(&image),
            Ok(json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" }))
        );

        let remote = json!({ "type": "image", "url": "https://example.test/a.png" });
        assert_eq!(
            encode_content(&remote),
            Err("ACP image input requires a base64 data URL".to_owned())
        );
    }

    #[test]
    fn a_file_url_encodes_what_node_encodes_and_leaves_the_rest() {
        assert_eq!(path_to_file_url("/work/a.ts"), "file:///work/a.ts");
        assert_eq!(
            path_to_file_url("/work/a b/ü.ts"),
            "file:///work/a%20b/%C3%BC.ts"
        );
        // Node's URL path set leaves these alone (`new URL('file:///a+(b),c')`).
        assert_eq!(
            path_to_file_url("/work/a+(b),c!@d=&e'f$;g[1].ts"),
            "file:///work/a+(b),c!@d=&e'f$;g[1].ts"
        );
        assert_eq!(
            path_to_file_url("/work/a#b?c%25.ts"),
            "file:///work/a%23b%3Fc%2525.ts"
        );
        // A Windows drive and its backslashes reach the URL as a path.
        assert_eq!(
            path_to_file_url("C:\\work\\a b.ts"),
            "file:///C:/work/a%20b.ts"
        );
        assert_eq!(
            path_to_file_url("\\\\server\\share\\a.ts"),
            "file://server/share/a.ts"
        );
    }

    #[test]
    fn a_resource_link_keeps_the_whole_file_name() {
        let long = "x".repeat(400);
        let link = json!({ "type": "file", "path": format!("/work/{long}.ts") });
        let encoded = encode_content(&link).unwrap_or(Value::Null);
        assert_eq!(
            encoded.get("name").and_then(Value::as_str),
            Some(format!("{long}.ts").as_str())
        );
    }

    #[test]
    fn an_image_without_a_mime_type_leaves_the_field_out() {
        let image = json!({
            "type": "image",
            "url": "data:application/octet-stream;base64,AAAA"
        });
        assert_eq!(
            encode_content(&image),
            Ok(json!({ "type": "image", "data": "AAAA" }))
        );
    }
}
