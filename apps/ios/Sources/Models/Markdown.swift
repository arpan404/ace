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

/// One block and where its first line starts, in UTF-8 bytes from the start of the text.
struct PlacedBlock: Equatable, Sendable {
    let start: Int
    let block: MarkdownBlock
}

/// The block parser as a line-by-line state machine, so a caller can resume it at any line where
/// nothing is open (`isIdle`): the blocks before that line are final. Pure.
struct MarkdownParser {
    private(set) var blocks: [PlacedBlock] = []
    private var paragraph: [String] = [], paragraphStart = 0, paragraphLast = 0
    private var quote: [String] = [], quoteStart = 0
    private var list: (ordered: Bool, start: Int, items: [String], at: Int)?
    private var fence: (marker: String, language: String, lines: [String], at: Int)?
    private var table: (headers: [String], rows: [[String]], at: Int)?

    /// Nothing is open, so the next line starts afresh whatever came before it.
    var isIdle: Bool { paragraph.isEmpty && quote.isEmpty && list == nil && fence == nil && table == nil }

    /// Blocks parsed elsewhere from the same text, taken whole while idle.
    mutating func adopt<S: Sequence>(_ placed: S) where S.Element == PlacedBlock { blocks.append(contentsOf: placed) }

    private mutating func flush() {
        if !paragraph.isEmpty { blocks.append(PlacedBlock(start: paragraphStart, block: .paragraph(paragraph.joined(separator: "\n")))); paragraph = [] }
        if !quote.isEmpty { blocks.append(PlacedBlock(start: quoteStart, block: .quote(quote.joined(separator: "\n")))); quote = [] }
        if let open = list { blocks.append(PlacedBlock(start: open.at, block: .list(ordered: open.ordered, start: open.start, items: open.items))); list = nil }
        if let open = table { blocks.append(PlacedBlock(start: open.at, block: .table(headers: open.headers, rows: open.rows))); table = nil }
    }

    /// Feeds one line, without its newline, that starts `offset` bytes into the text.
    mutating func feed(_ raw: Substring, at offset: Int) {
        let line = String(raw)
        let trimmed = Markdown.trimmed(line)
        if var open = fence {
            let mark = open.marker.first
            let run = trimmed.prefix { $0 == mark }
            if run.count >= open.marker.count && trimmed.dropFirst(run.count).allSatisfy(\.isWhitespace) {
                blocks.append(PlacedBlock(start: open.at, block: .code(language: open.language, text: open.lines.joined(separator: "\n"))))
                fence = nil
            } else {
                open.lines.append(line)
                fence = open
            }
            return
        }
        if let open = table {
            if let cells = Markdown.tableCells(line) {
                table?.rows.append(Array((cells + Array(repeating: "", count: open.headers.count)).prefix(open.headers.count)))
                return
            }
            flush()
        }
        if let separators = Markdown.tableCells(trimmed), separators.count > 1,
           separators.allSatisfy({ cell in
               let marks = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
               return marks.count >= 3 && marks.allSatisfy { $0 == "-" }
           }), let last = paragraph.last, let headers = Markdown.tableCells(last), headers.count == separators.count {
            let at = paragraphLast
            paragraph.removeLast(); flush()
            table = (headers, [], at)
            return
        }
        if let marker = Markdown.fenceMarker(trimmed) {
            flush()
            fence = (marker, String(trimmed.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces), [], offset)
            return
        }
        if trimmed.isEmpty { flush(); return }
        if let heading = Markdown.heading(trimmed) { flush(); blocks.append(PlacedBlock(start: offset, block: heading)); return }
        if Markdown.isRule(trimmed) { flush(); blocks.append(PlacedBlock(start: offset, block: .rule)); return }
        if trimmed.hasPrefix(">") {
            if !paragraph.isEmpty || list != nil { flush() }
            if quote.isEmpty { quoteStart = offset }
            quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
            return
        }
        if let item = Markdown.listItem(trimmed) {
            if !paragraph.isEmpty || !quote.isEmpty { flush() }
            if let open = list, open.ordered == item.ordered { list?.items.append(item.text) }
            else { flush(); list = (item.ordered, item.number, [item.text], offset) }
            return
        }
        if list != nil, line.hasPrefix("  "), var open = list, let last = open.items.popLast() {
            // An indented line continues the item above it.
            open.items.append(last + "\n" + trimmed)
            list = open
            return
        }
        if !quote.isEmpty || list != nil { flush() }
        if paragraph.isEmpty { paragraphStart = offset }
        paragraphLast = offset
        paragraph.append(line)
    }

    /// The blocks once the text ends here: a fence still streaming stays code.
    mutating func finish() -> [PlacedBlock] {
        if let open = fence { blocks.append(PlacedBlock(start: open.at, block: .code(language: open.language, text: open.lines.joined(separator: "\n")))); fence = nil }
        flush()
        return blocks
    }
}

enum Markdown {
    static func blocks(_ text: String) -> [MarkdownBlock] {
        var parser = MarkdownParser()
        var offset = 0
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            parser.feed(raw, at: offset)
            offset += raw.utf8.count + 1
        }
        return parser.finish().map(\.block)
    }

    /// `line` without the whitespace at its ends, as `trimmingCharacters(in: .whitespaces)`, but
    /// reading only the ends: a long streaming line costs nothing to trim.
    static func trimmed(_ line: String) -> String {
        let scalars = line.unicodeScalars, space = CharacterSet.whitespaces
        guard let first = scalars.firstIndex(where: { !space.contains($0) }),
              let last = scalars.lastIndex(where: { !space.contains($0) }) else { return "" }
        return String(scalars[first...last])
    }
    static func fenceMarker(_ line: String) -> String? {
        for character in ["`", "~"] {
            let run = line.prefix { String($0) == character }
            if run.count >= 3 { return String(run) }
        }
        return nil
    }
    /// Escaped pipes and pipes inside inline code belong to the cell, not its boundary.
    static func tableCells(_ line: String) -> [String]? {
        guard line.utf8.contains(0x7C) else { return nil }
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
    static func heading(_ line: String) -> MarkdownBlock? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }
    static func isRule(_ line: String) -> Bool {
        guard let lead = line.utf8.first, lead == 0x2D || lead == 0x2A || lead == 0x5F else { return false }
        let marks = line.filter { $0 != " " }
        guard marks.count >= 3, let first = marks.first, "-*_".contains(first) else { return false }
        return marks.allSatisfy { $0 == first }
    }
    static func listItem(_ line: String) -> (ordered: Bool, number: Int, text: String)? {
        if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
            return (false, 1, String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let mark = rest.first, mark == "." || mark == ")", rest.dropFirst().first == " " else { return nil }
        return (true, Int(digits) ?? 1, String(rest.dropFirst(2)))
    }

    /// A long paragraph cut into pieces after sentence ends, each with where it starts. A cut
    /// falls at the first sentence end at or past each multiple of `size` bytes counted from the
    /// start of the whole text (`at` is where this paragraph starts in it), and only once the
    /// character after that sentence end has arrived. So the cuts stay put while text is appended
    /// and while the front of a streaming window slides off: only the first and last pieces of a
    /// streaming paragraph change, and the pieces between are laid out and drawn once.
    static func pieces(_ paragraph: String, at start: Int = 0, size: Int = 2_000) -> [(offset: Int, text: Substring)] {
        let bytes = paragraph.utf8.withContiguousStorageIfAvailable(Self.sentenceCuts(size: size, start: start))
            ?? Array(paragraph.utf8).withUnsafeBufferPointer(Self.sentenceCuts(size: size, start: start))
        var pieces: [(offset: Int, text: Substring)] = []
        var from = 0
        let utf8 = paragraph.utf8
        for cut in bytes {
            pieces.append((start + from, paragraph[utf8.index(utf8.startIndex, offsetBy: from)..<utf8.index(utf8.startIndex, offsetBy: cut)]))
            // The space between two sentences belongs to neither piece.
            from = cut + 1
        }
        pieces.append((start + from, paragraph[utf8.index(utf8.startIndex, offsetBy: from)...]))
        return pieces
    }
    /// Where each piece ends, in bytes from the paragraph's start: just past its sentence end.
    private static func sentenceCuts(size: Int, start: Int) -> (UnsafeBufferPointer<UInt8>) -> [Int] {
        { bytes in
            var cuts: [Int] = []
            var target = (start / size + 1) * size
            var index = max(0, target - start)
            while index + 1 < bytes.count {
                let byte = bytes[index], next = bytes[index + 1]
                // ".", "!" or "?" followed by a space, tab or newline.
                if byte == 0x2E || byte == 0x21 || byte == 0x3F, next == 0x20 || next == 0x0A || next == 0x09 {
                    cuts.append(index + 1)
                    target = ((start + index) / size + 1) * size
                    index = max(index + 2, target - start)
                    continue
                }
                index += 1
            }
            return cuts
        }
    }

    /// Inline styling (emphasis, code spans, links); plain text when the span doesn't parse.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
