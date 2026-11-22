import Foundation

/// Markdown cut into the stretches ace draws differently: prose for markit, and the top-level
/// GitHub tables between it, which ace draws in a scroller of its own (`MarkdownTableView`) so a
/// wide table slides sideways under the finger while the transcript still scrolls up and down.
///
/// Only a table written at the margin is taken out: one inside a list or quote stays with its
/// prose. Nothing inside a code fence is read as a table. A link reference definition is moved
/// to the end of every piece, so each reference finds its definition wherever it was written,
/// and one arriving late in a stream leaves the tables where they are. Text that defines a
/// footnote is never cut: its note would show under every piece. Pure and line by line.
enum MarkdownBlocks {
    enum Piece: Equatable, Sendable {
        case prose(String)
        /// A table's own lines, header and delimiter rows first, then any link definitions.
        case table(String)
    }

    /// The whole text in one pass.
    static func split(_ written: String) -> [Piece] { Splitter().split(written) }

    /// Splits a streamed answer as it grows: each call reads on from the last place whose pieces
    /// can no longer change (`Scan.Resume`), so a growing answer costs the lines it added, not
    /// its whole text again. Text that doesn't carry on from the last call is read whole.
    final class Splitter {
        private var last: (text: String, scan: Scan)?

        func split(_ written: String) -> [Piece] {
            // Most text has no table at all: no delimiter row can be there without both.
            guard written.utf8.contains(UInt8(ascii: "|")), written.utf8.contains(UInt8(ascii: "-")) else {
                last = nil
                return [.prose(written)]
            }
            // Swift reads "\r\n" as one character, so lines are cut only once every ending is "\n".
            let text = written.utf8.contains(UInt8(ascii: "\r")) ? written.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") : written
            var scan = Scan()
            if let last, let resume = last.scan.resume, text.utf8.count >= resume.offset,
               text.utf8.prefix(resume.offset).elementsEqual(last.text.utf8.prefix(resume.offset)) {
                scan = last.scan.rewound(to: resume)
            }
            scan.read(text)
            last = (text, scan)
            return scan.pieces(of: text)
        }
    }

    /// What a read found so far: the pieces without their definitions, the definitions, and
    /// where a later read of a longer text may start.
    struct Scan {
        /// A line start before which every piece is final: the lines it rests on are whole
        /// (a later line follows them), so nothing appended can change them.
        struct Resume {
            /// UTF-8 offset of the line it starts at.
            let offset: Int
            let pieces: Int
            let definitions: Int
            let footnote: Bool
            /// The line before it, which decides whether a table may start there.
            let previous: String?
        }
        private(set) var found: [Piece] = []
        private(set) var definitions: [String] = []
        private(set) var footnote = false
        private(set) var resume: Resume?

        func rewound(to resume: Resume) -> Scan {
            var scan = Scan()
            scan.found = Array(found.prefix(resume.pieces))
            scan.definitions = Array(definitions.prefix(resume.definitions))
            scan.footnote = resume.footnote
            scan.resume = resume
            return scan
        }

        /// The text's pieces, each closed with every definition; the text whole when it defines a
        /// footnote or holds no table.
        func pieces(of text: String) -> [Piece] {
            guard !footnote, found.contains(where: { if case .table = $0 { true } else { false } }) else { return [.prose(text)] }
            guard !definitions.isEmpty else { return found }
            let tail = "\n\n" + definitions.joined(separator: "\n")
            return found.map { piece in
                switch piece {
                case .prose(let prose): .prose(prose + tail)
                case .table(let table): .table(table + tail)
                }
            }
        }

        /// Reads `text` on from `resume` (the start when there is none).
        mutating func read(_ text: String) {
            let from = resume?.offset ?? 0
            let start = text.utf8.index(text.utf8.startIndex, offsetBy: from)
            let lines = text[start...].split(separator: "\n", omittingEmptySubsequences: false)
            // Each line's UTF-8 offset in the text.
            var offsets: [Int] = []
            offsets.reserveCapacity(lines.count)
            var at = from
            for line in lines {
                offsets.append(at)
                at += line.utf8.count + 1
            }
            let previousLine = resume?.previous.map { Substring($0) }
            func before(_ index: Int) -> Substring? { index > 0 ? lines[index - 1] : previousLine }
            /// A line is whole once another follows it.
            func whole(_ index: Int) -> Bool { index < lines.count - 1 }
            func mark(_ index: Int) {
                resume = Resume(offset: offsets[index], pieces: found.count, definitions: definitions.count,
                                footnote: footnote, previous: before(index).map(String.init))
            }
            var prose: [Substring] = []
            var fence: Fence?
            var defining = false
            var index = 0
            func flushProse() {
                // The blank lines around a table belong to neither side.
                while let last = prose.last, isBlank(last) { prose.removeLast() }
                while let first = prose.first, isBlank(first) { prose.removeFirst() }
                if !prose.isEmpty { found.append(.prose(prose.joined(separator: "\n"))) }
                prose = []
            }
            while index < lines.count {
                let line = lines[index]
                if let open = fence {
                    if open.closes(line) { fence = nil }
                    prose.append(line)
                    index += 1
                    continue
                }
                if let opened = Fence(opening: line) {
                    fence = opened
                    defining = false
                    prose.append(line)
                    index += 1
                    continue
                }
                if isFootnote(line) { footnote = true }
                // A definition can't break into a paragraph: only one after a blank line, the
                // start, or another definition is one. A title may carry on, indented or quoted.
                let afterBreak = before(index).map(isBlank) ?? true
                if isDefinition(line), afterBreak || defining {
                    definitions.append(String(line))
                    defining = true
                    index += 1
                    while index < lines.count, isContinuation(lines[index]) {
                        definitions[definitions.count - 1] += "\n" + lines[index]
                        index += 1
                    }
                    continue
                }
                defining = false
                if index + 1 < lines.count, startsTable(header: line, delimiter: lines[index + 1], after: before(index)) {
                    var end = index + 2
                    while end < lines.count, isRow(lines[end]) { end += 1 }
                    flushProse()
                    // Its header and delimiter rows whole, the prose before it is final.
                    if whole(index + 1) { mark(index) }
                    found.append(.table(lines[index..<end].joined(separator: "\n")))
                    index = end
                    // The line that ended it whole, so is the table.
                    if whole(end) { mark(end) }
                    continue
                }
                prose.append(line)
                index += 1
            }
            flushProse()
        }
    }

    /// A header row at the margin, the delimiter row under it with as many cells, and above it a
    /// blank line, the start, or a line of plain prose (a table may end a paragraph).
    private static func startsTable(header: Substring, delimiter: Substring, after previous: Substring?) -> Bool {
        guard let first = header.first, first != " ", first != "\t", header.contains("|") else { return false }
        guard !startsOtherBlock(header) else { return false }
        if let previous, !isBlank(previous), !isPlainProse(previous) { return false }
        let columns = cells(header).count
        let rule = cells(delimiter)
        guard delimiter.contains("|"), rule.count == columns else { return false }
        return rule.allSatisfy(isDelimiterCell)
    }

    /// A line that carries on the table: not blank, holding a pipe anywhere (edge pipes are
    /// optional), and not the start of another block. A list item ends the table even with a
    /// pipe in it: markit reads it as a list, which the table view wouldn't draw.
    private static func isRow(_ line: Substring) -> Bool {
        !isBlank(line) && line.contains("|") && !startsOtherBlock(line) && Fence(opening: line) == nil
            && !isListItem(line.drop { $0 == " " || $0 == "\t" })
    }

    /// A line at the margin that is plain prose, not part of a list, quote or code.
    private static func isPlainProse(_ line: Substring) -> Bool {
        guard let first = line.first, first != " ", first != "\t" else { return false }
        return !startsOtherBlock(line) && !isListItem(line)
    }

    private static func startsOtherBlock(_ line: Substring) -> Bool {
        let trimmed = line.drop { $0 == " " }
        return trimmed.hasPrefix(">") || trimmed.hasPrefix("#")
    }

    private static func isListItem(_ line: Substring) -> Bool {
        if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " { return true }
        let digits = line.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 9 else { return false }
        let rest = line.dropFirst(digits.count)
        return (rest.first == "." || rest.first == ")") && (rest.dropFirst().first == " " || rest.count == 1)
    }

    /// A footnote's `[^label]: note`, at most three spaces in.
    private static func isFootnote(_ line: Substring) -> Bool {
        isDefinition(line) && line.drop { $0 == " " }.hasPrefix("[^")
    }

    /// A definition's title on the line after it: indented, or opened with a quote or a paren.
    private static func isContinuation(_ line: Substring) -> Bool {
        guard let first = line.first, !isBlank(line) else { return false }
        return first == " " || first == "\t" || first == "\"" || first == "'" || first == "("
    }

    /// `[label]: target` or a footnote's `[^label]: note`, at most three spaces in.
    private static func isDefinition(_ line: Substring) -> Bool {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return false }
        let rest = line.dropFirst(indent)
        guard rest.first == "[", let close = rest.firstIndex(of: "]"), close > rest.index(after: rest.startIndex) else { return false }
        return rest[rest.index(after: close)...].first == ":"
    }

    private static func isDelimiterCell(_ cell: Substring) -> Bool {
        var body = cell.trimmingCharacters(in: .whitespacesAndNewlines)[...]
        if body.first == ":" { body = body.dropFirst() }
        if body.last == ":" { body = body.dropLast() }
        return !body.isEmpty && body.allSatisfy { $0 == "-" }
    }

    /// A row's cells: split at pipes not escaped with a backslash, without the edge pipes.
    static func cells(_ line: Substring) -> [Substring] {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)[...]
        var cells: [Substring] = []
        var start = trimmed.startIndex
        var at = trimmed.startIndex
        var escaped = false
        while at < trimmed.endIndex {
            let character = trimmed[at]
            if escaped { escaped = false } else if character == "\\" { escaped = true } else if character == "|" {
                cells.append(trimmed[start..<at])
                start = trimmed.index(after: at)
            }
            at = trimmed.index(after: at)
        }
        cells.append(trimmed[start..<trimmed.endIndex])
        if trimmed.hasPrefix("|") { cells.removeFirst() }
        if trimmed.hasSuffix("|"), !trimmed.hasSuffix("\\|"), !cells.isEmpty { cells.removeLast() }
        return cells
    }

    private static func isBlank(_ line: Substring) -> Bool { line.allSatisfy { $0 == " " || $0 == "\t" || $0 == "\r" } }

    /// An open code fence: three or more backticks or tildes, at most three spaces in. It closes
    /// on a line of at least as many of the same character and nothing else.
    private struct Fence {
        let mark: Character
        let length: Int
        init?(opening line: Substring) {
            let indent = line.prefix { $0 == " " }.count
            guard indent <= 3 else { return nil }
            let rest = line.dropFirst(indent)
            guard let mark = rest.first, mark == "`" || mark == "~" else { return nil }
            let length = rest.prefix { $0 == mark }.count
            guard length >= 3 else { return nil }
            // A backtick fence's info string can't hold a backtick.
            if mark == "`", rest.dropFirst(length).contains("`") { return nil }
            self.mark = mark
            self.length = length
        }
        func closes(_ line: Substring) -> Bool {
            let indent = line.prefix { $0 == " " }.count
            guard indent <= 3 else { return false }
            let rest = line.dropFirst(indent).trimmingCharacters(in: .whitespacesAndNewlines)
            return rest.count >= length && rest.allSatisfy { $0 == mark }
        }
    }
}
