import Foundation

/// Markdown cut into the stretches ace draws differently: prose for markit, and the top-level
/// GitHub tables between it, which ace draws in a scroller of its own (`MarkdownTableView`) so a
/// wide table slides sideways under the finger while the transcript still scrolls up and down.
///
/// Only a table written at the margin is taken out: one inside a list or quote stays with its
/// prose. Text that defines link references or footnotes is never cut, so every reference keeps
/// its definition, and nothing inside a code fence is read as a table. Pure and line by line, so
/// a streamed answer costs one pass over its text.
enum MarkdownBlocks {
    enum Piece: Equatable, Sendable {
        case prose(String)
        /// A table's own lines, header and delimiter rows first.
        case table(String)
    }

    static func split(_ written: String) -> [Piece] {
        // Most text has no table at all: no delimiter row can be there without both.
        guard written.contains("|"), written.contains("-") else { return [.prose(written)] }
        // Swift reads "\r\n" as one character, so lines are cut only once every ending is "\n".
        let text = written.utf8.contains(UInt8(ascii: "\r")) ? written.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") : written
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var pieces: [Piece] = []
        var prose: [Substring] = []
        var fence: Fence?
        var index = 0
        func flushProse() {
            // The blank lines around a table belong to neither side.
            while let last = prose.last, isBlank(last) { prose.removeLast() }
            while let first = prose.first, isBlank(first) { prose.removeFirst() }
            if !prose.isEmpty { pieces.append(.prose(prose.joined(separator: "\n"))) }
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
                prose.append(line)
                index += 1
                continue
            }
            if isDefinition(line) { return [.prose(text)] }
            if index + 1 < lines.count, startsTable(header: line, delimiter: lines[index + 1], after: index > 0 ? lines[index - 1] : nil) {
                var end = index + 2
                while end < lines.count, isRow(lines[end]) { end += 1 }
                flushProse()
                pieces.append(.table(lines[index..<end].joined(separator: "\n")))
                index = end
                continue
            }
            prose.append(line)
            index += 1
        }
        flushProse()
        return pieces.isEmpty ? [.prose(text)] : pieces
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
