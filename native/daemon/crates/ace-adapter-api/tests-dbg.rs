#[test]
fn debug_elide_chunk1() {
    let image = format!("data:image/png;base64,{}", "QUJD".repeat(64));
    let data = "QUJD".repeat(64);
    let text = "héllo wörld \\u00e9 \u{1F600} ".repeat(16);
    let value = format!(
        "{{\"small\":\"a\\\"quoted\\\\ value\",\"image\":\"{image}\",\"data\":\"{data}\",\"text\":\"{text}\",\"nested\":[{{\"keep\":\"{}\"}}]}}",
        "x".repeat(40)
    );
    eprintln!("INPUT-JSON-TAIL: {:?}", &value[value.len() - 60..]);
    for chunk_bytes in [1usize, 7, 64, 4096] {
        let out = super::elide_for_test(&value, chunk_bytes);
        let parsed: serde_json::Value = serde_json::from_str(&out).expect("stays JSON");
        eprintln!("chunk {chunk_bytes} text: {:?}", parsed["text"]);
    }
    panic!("show output");
}
