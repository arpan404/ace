//! Rich paste: markdown to HTML, and the HTML clipboard format Windows apps read ("HTML
//! Format", with byte offsets in a header). Pure. The markdown subset is what agents write:
//! headings, paragraphs, bullet and numbered lists, fenced code, bold, italic, inline code and
//! links.

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

/// Inline spans: `code`, **bold**, *italic* or _italic_, and [text](url).
fn inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let find = |from: usize, close: &[char]| -> Option<usize> {
        (from..chars.len().saturating_sub(close.len() - 1))
            .find(|&at| chars[at..].starts_with(close))
    };
    while i < chars.len() {
        let rest = &chars[i..];
        if rest[0] == '`' {
            if let Some(end) = find(i + 1, &['`']) {
                let code: String = chars[i + 1..end].iter().collect();
                out.push_str(&format!("<code>{}</code>", escape(&code)));
                i = end + 1;
                continue;
            }
        }
        if rest.starts_with(&['*', '*']) {
            if let Some(end) = find(i + 2, &['*', '*']) {
                let inner: String = chars[i + 2..end].iter().collect();
                out.push_str(&format!("<strong>{}</strong>", inline(&inner)));
                i = end + 2;
                continue;
            }
        }
        if matches!(rest[0], '*' | '_') && rest.len() > 1 && !rest[1].is_whitespace() {
            if let Some(end) = find(i + 1, &[rest[0]]) {
                let inner: String = chars[i + 1..end].iter().collect();
                out.push_str(&format!("<em>{}</em>", inline(&inner)));
                i = end + 1;
                continue;
            }
        }
        if rest[0] == '[' {
            if let Some(close) = find(i + 1, &[']', '(']) {
                if let Some(end) = find(close + 2, &[')']) {
                    let label: String = chars[i + 1..close].iter().collect();
                    let url: String = chars[close + 2..end].iter().collect();
                    out.push_str(&format!(
                        "<a href=\"{}\">{}</a>",
                        escape(url.trim()),
                        inline(&label)
                    ));
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push_str(&escape(&rest[0].to_string()));
        i += 1;
    }
    out
}

#[derive(PartialEq)]
enum List {
    None,
    Bullets,
    Numbers,
}

fn list_item(line: &str) -> Option<(List, &str)> {
    let trimmed = line.trim_start();
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(bullet) {
            return Some((List::Bullets, rest));
        }
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        if let Some(rest) = trimmed[digits..]
            .strip_prefix(". ")
            .or_else(|| trimmed[digits..].strip_prefix(") "))
        {
            return Some((List::Numbers, rest));
        }
    }
    None
}

pub fn markdown_to_html(markdown: &str) -> String {
    let mut html = String::new();
    let mut list = List::None;
    let mut paragraph: Vec<String> = Vec::new();
    let mut code: Option<Vec<String>> = None;
    let close_list = |html: &mut String, list: &mut List| {
        match list {
            List::Bullets => html.push_str("</ul>"),
            List::Numbers => html.push_str("</ol>"),
            List::None => {}
        }
        *list = List::None;
    };
    let flush = |html: &mut String, paragraph: &mut Vec<String>| {
        if !paragraph.is_empty() {
            html.push_str(&format!("<p>{}</p>", inline(&paragraph.join(" "))));
            paragraph.clear();
        }
    };
    for line in markdown.lines() {
        if let Some(block) = code.as_mut() {
            if line.trim_start().starts_with("```") {
                html.push_str(&format!(
                    "<pre><code>{}</code></pre>",
                    escape(&block.join("\n"))
                ));
                code = None;
            } else {
                block.push(line.to_owned());
            }
            continue;
        }
        if line.trim_start().starts_with("```") {
            flush(&mut html, &mut paragraph);
            close_list(&mut html, &mut list);
            code = Some(Vec::new());
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush(&mut html, &mut paragraph);
            close_list(&mut html, &mut list);
            continue;
        }
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && trimmed[level..].starts_with(' ') {
            flush(&mut html, &mut paragraph);
            close_list(&mut html, &mut list);
            html.push_str(&format!(
                "<h{level}>{}</h{level}>",
                inline(trimmed[level..].trim())
            ));
            continue;
        }
        if let Some((kind, item)) = list_item(line) {
            flush(&mut html, &mut paragraph);
            if kind != list {
                close_list(&mut html, &mut list);
                html.push_str(if kind == List::Bullets {
                    "<ul>"
                } else {
                    "<ol>"
                });
                list = kind;
            }
            html.push_str(&format!("<li>{}</li>", inline(item.trim())));
            continue;
        }
        close_list(&mut html, &mut list);
        paragraph.push(trimmed.to_owned());
    }
    if let Some(block) = code {
        html.push_str(&format!(
            "<pre><code>{}</code></pre>",
            escape(&block.join("\n"))
        ));
    }
    flush(&mut html, &mut paragraph);
    close_list(&mut html, &mut list);
    html
}

/// The clipboard's "HTML Format": a header of byte offsets, then the document with the
/// fragment between StartFragment and EndFragment comments. Offsets are into the UTF-8 bytes.
pub fn clipboard_html(fragment: &str) -> String {
    const HEADER: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let before = "<html><body>\r\n<!--StartFragment-->";
    let after = "<!--EndFragment-->\r\n</body></html>";
    let start_html = HEADER.len();
    let start_fragment = start_html + before.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + after.len();
    format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n{before}{fragment}{after}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_keeps_headings_lists_and_emphasis() {
        let html = markdown_to_html("# Plan\n\nShip **today** and *test*.\n\n- one\n- `two`\n\n1. first\n2. [docs](https://acehq.dev)");
        assert_eq!(
            html,
            "<h1>Plan</h1><p>Ship <strong>today</strong> and <em>test</em>.</p><ul><li>one</li><li><code>two</code></li></ul><ol><li>first</li><li><a href=\"https://acehq.dev\">docs</a></li></ol>"
        );
    }

    #[test]
    fn code_blocks_and_markup_characters_are_escaped() {
        assert_eq!(
            markdown_to_html("```\n<b> & </b>\n```"),
            "<pre><code>&lt;b&gt; &amp; &lt;/b&gt;</code></pre>"
        );
        assert_eq!(markdown_to_html("a < b"), "<p>a &lt; b</p>");
    }

    #[test]
    fn clipboard_offsets_point_at_the_fragment() {
        let payload = clipboard_html("<b>é</b>");
        let number = |key: &str| -> usize {
            let at = payload.find(key).unwrap() + key.len();
            payload[at..at + 10].parse().unwrap()
        };
        let bytes = payload.as_bytes();
        assert_eq!(
            &bytes[number("StartFragment:")..number("EndFragment:")],
            "<b>é</b>".as_bytes()
        );
        assert_eq!(number("EndHTML:"), bytes.len());
        assert!(payload[number("StartHTML:")..].starts_with("<html>"));
    }
}
