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
        if first == "[", let close = rest.range(of: "]("), let end = rest[close.upperBound...].firstIndex(of: ")") {
            let label = rest[rest.index(after: rest.startIndex)..<close.lowerBound]
            let url = rest[close.upperBound..<end]
            out += "<a href=\"\(cuEscapeHTML(String(url)))\">\(cuInlineMarkdown(String(label)))</a>"
            rest = rest[rest.index(after: end)...]
            continue
        }
        out += cuEscapeHTML(String(first))
        rest = rest.dropFirst()
    }
    return out
}
