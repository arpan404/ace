import Foundation

/// The block structure of an agent's Markdown: enough for a phone transcript (paragraphs,
/// headings, lists, quotes, rules and fenced code). Inline styling is left to Foundation's
/// inline Markdown parser. A fence still streaming stays code until it closes. Pure.
enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case code(language: String, text: String)
    case list(ordered: Bool, start: Int, items: [String])
    case quote(String)
    case table(headers: [String], rows: [[String]])
    case rule
}

enum Markdown {
    static func blocks(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var list: (ordered: Bool, start: Int, items: [String])?
        var fence: (marker: String, language: String, lines: [String])?
        var table: (headers: [String], rows: [[String]])?

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
            if let open = list { blocks.append(.list(ordered: open.ordered, start: open.start, items: open.items)); list = nil }
            if let open = table { blocks.append(.table(headers: open.headers, rows: open.rows)); table = nil }
        }

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if var open = fence {
                let mark = open.marker.first
                let run = trimmed.prefix { $0 == mark }
                if run.count >= open.marker.count && trimmed.dropFirst(run.count).allSatisfy(\.isWhitespace) {
                    blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    open.lines.append(line)
                    fence = open
                }
                continue
            }
            if let open = table {
                if let cells = tableCells(line) {
                    table?.rows.append(Array((cells + Array(repeating: "", count: open.headers.count)).prefix(open.headers.count)))
                    continue
                }
                flush()
            }
            if let separators = tableCells(trimmed), separators.count > 1,
               separators.allSatisfy({ cell in
                   let marks = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
                   return marks.count >= 3 && marks.allSatisfy { $0 == "-" }
               }), let last = paragraph.last, let headers = tableCells(last), headers.count == separators.count {
                paragraph.removeLast(); flush()
                table = (headers, [])
                continue
            }
            if let marker = fenceMarker(trimmed) {
                flush()
                fence = (marker, String(trimmed.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces), [])
                continue
            }
            if trimmed.isEmpty { flush(); continue }
            if let heading = heading(trimmed) { flush(); blocks.append(heading); continue }
            if isRule(trimmed) { flush(); blocks.append(.rule); continue }
            if trimmed.hasPrefix(">") {
                if !paragraph.isEmpty || list != nil { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            if let item = listItem(trimmed) {
                if !paragraph.isEmpty || !quote.isEmpty { flush() }
                if let open = list, open.ordered == item.ordered { list?.items.append(item.text) }
                else { flush(); list = (item.ordered, item.number, [item.text]) }
                continue
            }
            if list != nil, line.hasPrefix("  "), var open = list, let last = open.items.popLast() {
                // An indented line continues the item above it.
                open.items.append(last + "\n" + trimmed)
                list = open
                continue
            }
            if !quote.isEmpty || list != nil { flush() }
            paragraph.append(line)
        }
        if let open = fence { blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func fenceMarker(_ line: String) -> String? {
        for character in ["`", "~"] {
            let run = line.prefix { String($0) == character }
            if run.count >= 3 { return String(run) }
        }
        return nil
    }
    /// Escaped pipes and pipes inside inline code belong to the cell, not its boundary.
    private static func tableCells(_ line: String) -> [String]? {
        var cells: [String] = [], cell = "", escaped = false, code = false, divided = false
        for character in line.trimmingCharacters(in: .whitespaces) {
            if escaped { cell.append(character); escaped = false; continue }
            if character == "\\" { escaped = true; continue }
            if character == "`" { code.toggle() }
            if character == "|", !code { cells.append(cell.trimmingCharacters(in: .whitespaces)); cell = ""; divided = true }
            else { cell.append(character) }
        }
        if escaped { cell.append("\\") }
        guard divided else { return nil }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        if cells.first == "" { cells.removeFirst() }
        if cells.last == "" { cells.removeLast() }
        return cells.isEmpty ? nil : cells
    }
    private static func heading(_ line: String) -> MarkdownBlock? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }
    private static func isRule(_ line: String) -> Bool {
        let marks = line.filter { $0 != " " }
        guard marks.count >= 3, let first = marks.first, "-*_".contains(first) else { return false }
        return marks.allSatisfy { $0 == first }
    }
    private static func listItem(_ line: String) -> (ordered: Bool, number: Int, text: String)? {
        if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
            return (false, 1, String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let mark = rest.first, mark == "." || mark == ")", rest.dropFirst().first == " " else { return nil }
        return (true, Int(digits) ?? 1, String(rest.dropFirst(2)))
    }

    /// A long paragraph cut into pieces at sentence ends, each at least `size` characters but
    /// the last. A piece ends only once the character after its sentence end has arrived, so
    /// text appended while a message streams only ever changes the last piece: the pieces
    /// before it are laid out and drawn once rather than on every delta.
    static func pieces(_ paragraph: String, size: Int = 2_000) -> [Substring] {
        var pieces: [Substring] = []
        var start = paragraph.startIndex
        var length = 0
        var index = paragraph.startIndex
        while index < paragraph.endIndex {
            let character = paragraph[index]
            let next = paragraph.index(after: index)
            length += 1
            if length >= size, ".!?".contains(character), next < paragraph.endIndex, paragraph[next].isWhitespace {
                pieces.append(paragraph[start..<next])
                // The space between two sentences belongs to neither piece.
                start = paragraph.index(after: next)
                index = start
                length = 0
                continue
            }
            index = next
        }
        if start < paragraph.endIndex || pieces.isEmpty { pieces.append(paragraph[start...]) }
        return pieces
    }

    /// Inline styling (emphasis, code spans, links); plain text when the span doesn't parse.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
