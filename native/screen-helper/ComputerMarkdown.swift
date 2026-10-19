import Foundation

/// Markdown to HTML for pasting into documents: headings, paragraphs, lists, fenced code,
/// emphasis, inline code and links. Anything else stays as escaped text.
func cuMarkdownHTML(_ markdown: String) -> String {
    var html: [String] = []
    var paragraph: [String] = []
    var list: (tag: String, items: [String])?
    var code: [String]?

    func flushParagraph() {
        if !paragraph.isEmpty { html.append("<p>\(paragraph.map(cuInlineMarkdown).joined(separator: "<br>"))</p>"); paragraph = [] }
    }
    func flushList() {
        if let current = list { html.append("<\(current.tag)>\(current.items.map { "<li>\($0)</li>" }.joined())</\(current.tag)>"); list = nil }
    }

    for raw in markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
        if code != nil {
            if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") { html.append("<pre><code>\(code!.map(cuEscapeHTML).joined(separator: "\n"))</code></pre>"); code = nil }
            else { code!.append(raw) }
            continue
        }
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("```") { flushParagraph(); flushList(); code = []; continue }
        if line.isEmpty { flushParagraph(); flushList(); continue }
        if let level = cuHeadingLevel(line) {
            flushParagraph(); flushList()
            html.append("<h\(level)>\(cuInlineMarkdown(String(line.dropFirst(level + 1))))</h\(level)>")
            continue
        }
        if let item = cuListItem(line) {
            flushParagraph()
            if list?.tag != item.tag { flushList(); list = (item.tag, []) }
            list?.items.append(cuInlineMarkdown(item.text))
            continue
        }
        flushList()
        paragraph.append(line)
    }
    if let code { html.append("<pre><code>\(code.map(cuEscapeHTML).joined(separator: "\n"))</code></pre>") }
    flushParagraph(); flushList()
    return html.joined()
}

func cuEscapeHTML(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
}

private func cuHeadingLevel(_ line: String) -> Int? {
    let hashes = line.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
    return hashes
}

private func cuListItem(_ line: String) -> (tag: String, text: String)? {
    for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) { return ("ul", String(line.dropFirst(2))) }
    let digits = line.prefix { $0.isNumber }
    if !digits.isEmpty, line.dropFirst(digits.count).hasPrefix(". ") { return ("ol", String(line.dropFirst(digits.count + 2))) }
    return nil
}

/// Inline spans, scanned left to right so markers inside code or links are left alone.
func cuInlineMarkdown(_ text: String) -> String {
    var out = ""
    var rest = Substring(text)
    func take(between open: String, _ close: String) -> Substring? {
        guard rest.hasPrefix(open), let end = rest.dropFirst(open.count).range(of: close) else { return nil }
        let inner = rest[rest.index(rest.startIndex, offsetBy: open.count)..<end.lowerBound]
        guard !inner.isEmpty else { return nil }
        rest = rest[end.upperBound...]
        return inner
    }
    while let first = rest.first {
        if let inner = take(between: "`", "`") { out += "<code>\(cuEscapeHTML(String(inner)))</code>"; continue }
        if let inner = take(between: "**", "**") { out += "<strong>\(cuInlineMarkdown(String(inner)))</strong>"; continue }
        if let inner = take(between: "__", "__") { out += "<strong>\(cuInlineMarkdown(String(inner)))</strong>"; continue }
        if let inner = take(between: "*", "*") { out += "<em>\(cuInlineMarkdown(String(inner)))</em>"; continue }
        if first == "[", let link = cuLink(at: rest) {
            let label = cuInlineMarkdown(link.label)
            out += cuSafeURL(link.url).map { "<a href=\"\(cuEscapeHTML($0))\">\(label)</a>" } ?? label
            rest = link.rest
            continue
        }
        out += cuEscapeHTML(String(first))
        rest = rest.dropFirst()
    }
    return out
}

/// A `[label](url)` link starting at `text`: the label runs to its matching "]" (nested
/// brackets allowed), which must be followed directly by "(", and the URL to the matching ")".
private func cuLink(at text: Substring) -> (label: String, url: String, rest: Substring)? {
    guard text.first == "[" else { return nil }
    var depth = 0
    var index = text.startIndex
    var labelEnd: Substring.Index?
    while index < text.endIndex {
        let character = text[index]
        if character == "[" { depth += 1 }
        if character == "]" { depth -= 1; if depth == 0 { labelEnd = index; break } }
        index = text.index(after: index)
    }
    guard let labelEnd else { return nil }
    let open = text.index(after: labelEnd)
    guard open < text.endIndex, text[open] == "(" else { return nil }
    var parens = 0
    index = open
    while index < text.endIndex {
        let character = text[index]
        if character == "(" { parens += 1 }
        if character == ")" {
            parens -= 1
            if parens == 0 {
                let label = String(text[text.index(after: text.startIndex)..<labelEnd])
                let url = String(text[text.index(after: open)..<index]).trimmingCharacters(in: .whitespaces)
                guard !label.isEmpty else { return nil }
                return (label, url, text[text.index(after: index)...])
            }
        }
        index = text.index(after: index)
    }
    return nil
}

/// Links that run code or embed data are dropped (their text stays).
func cuSafeURL(_ url: String) -> String? {
    let scheme = url.lowercased().filter { !$0.isWhitespace && !$0.isNewline && $0 != "\u{0}" }
    for blocked in ["javascript:", "data:", "vbscript:"] where scheme.hasPrefix(blocked) { return nil }
    return url.isEmpty ? nil : url
}
