import Foundation

/// A place in a file's text: a 0-based line and a UTF-16 column, as `CodeAnnotation` in
/// `@ace/ui-core` keeps it.
struct TextPlace: Codable, Hashable, Sendable, Comparable {
    var line: Int
    var column: Int
    static func < (a: TextPlace, b: TextPlace) -> Bool { a.line != b.line ? a.line < b.line : a.column < b.column }
}

/// A range of text, `end` exclusive.
struct TextSpan: Codable, Hashable, Sendable {
    var start: TextPlace
    var end: TextPlace
}

/// Where a range is now, and whether its code is gone.
struct Anchored: Equatable, Sendable {
    var span: TextSpan
    var outdated: Bool
}

/// One replaced range of an edit, in the text before it, and where its new text ends after it.
struct TextReplacement: Equatable, Sendable {
    var start: TextPlace
    var end: TextPlace
    var postEnd: TextPlace

    /// The text between `start` and `end` replaced by `typed`.
    static func replacing(from start: TextPlace, to end: TextPlace, with typed: String) -> TextReplacement {
        var lines = 0, tail = 0
        for unit in typed.utf16 {
            if unit == 10 { lines += 1; tail = 0 } else { tail += 1 }
        }
        let postEnd = lines == 0 ? TextPlace(line: start.line, column: start.column + tail) : TextPlace(line: start.line + lines, column: tail)
        return TextReplacement(start: start, end: end, postEnd: postEnd)
    }
}

/// A range's text as the note keeps it: its first lines, and whether it was cut short.
struct CodeExcerpt: Equatable, Sendable {
    var text: String
    var cut: Bool
}

/// Keeping a note on its code, by the web editor's rules (`annotate-anchor.ts`). Through an edit
/// the range is carried by the ranges the edit replaced, in work proportional to the edit; through
/// a whole-text change (an agent rewrote the file) it is found again by its unchanged lines or by
/// its exact text, once. A range whose code is gone becomes outdated where it was; it is never
/// moved onto other code. Pure.
enum AnnotationAnchor {
    /// The longest excerpt kept (`codeExcerptLimit` in `@ace/ui-core`).
    static let excerptLimit = 4000

    /// A text's lines, split on line feeds only, as the editor counts them.
    static func lines(_ text: String) -> [String] { text.components(separatedBy: "\n") }

    /// Code is the same when its UTF-16 units are, as the web compares it: Swift's own `==`
    /// would also match "é" to "e" with a combining accent.
    static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
    static func same(_ a: [String], _ b: [String]) -> Bool { a.count == b.count && zip(a, b).allSatisfy { same($0, $1) } }
    private static func starts(_ text: String, with prefix: String) -> Bool { text.utf16.starts(with: prefix.utf16) }

    // MARK: Through an edit

    /// `at` after the edits before it, when no edit touched it: shifted by the last one's growth.
    private static func shifted(_ at: TextPlace, _ previous: TextReplacement?) -> TextPlace {
        guard let previous else { return at }
        if at.line == previous.end.line {
            return TextPlace(line: previous.postEnd.line, column: at.column + (previous.postEnd.column - previous.end.column))
        }
        return TextPlace(line: at.line + (previous.postEnd.line - previous.end.line), column: at.column)
    }

    /// A range's edge through one edit's replaced ranges (document order, old coordinates). Text
    /// typed on the range's own edge joins it; an edge inside replaced text moves to that text's
    /// far side, so the range only shrinks around what is left of its own code.
    private static func mapEdge(_ at: TextPlace, _ replacements: [TextReplacement], start: Bool) -> TextPlace {
        var previous: TextReplacement?
        for change in replacements {
            if at < change.start { break }
            if at > change.end { previous = change; continue }
            let postStart = shifted(change.start, previous)
            if start { return at == change.start ? postStart : change.postEnd }
            return at == change.end ? change.postEnd : postStart
        }
        return shifted(at, previous)
    }

    /// A range through an edit; its code is gone when nothing of it is left.
    static func map(_ span: TextSpan, through replacements: [TextReplacement]) -> Anchored {
        let start = mapEdge(span.start, replacements, start: true)
        let end = mapEdge(span.end, replacements, start: false)
        if span.start < span.end, start >= end { return Anchored(span: TextSpan(start: start, end: start), outdated: true) }
        return Anchored(span: TextSpan(start: start, end: end), outdated: false)
    }

    /// Whether any replaced range overlaps or touches the span, so its text may have changed.
    static func touches(_ span: TextSpan, _ replacements: [TextReplacement]) -> Bool {
        replacements.contains { $0.start <= span.end && $0.end >= span.start }
    }

    // MARK: Text

    /// `line`'s UTF-16 units from `from` up to `to` (clamped).
    private static func slice(_ line: String, from: Int, to: Int? = nil) -> String {
        let units = line as NSString
        let low = min(max(0, from), units.length)
        let high = min(max(low, to ?? units.length), units.length)
        return units.substring(with: NSRange(location: low, length: high - low))
    }

    /// The text between a range's edges.
    static func text(of span: TextSpan, in lines: [String]) -> String {
        text(of: span) { $0 < lines.count ? lines[$0] : "" }
    }
    /// The text between a range's edges, reading only its own lines (0-based, without breaks).
    static func text(of span: TextSpan, line: (Int) -> String) -> String {
        let (start, end) = (span.start, span.end)
        if start.line == end.line { return slice(line(start.line), from: start.column, to: end.column) }
        var parts = [slice(line(start.line), from: start.column)]
        var at = start.line + 1
        while at < end.line { parts.append(line(at)); at += 1 }
        parts.append(slice(line(end.line), from: 0, to: end.column))
        return parts.joined(separator: "\n")
    }

    /// A range's text as an excerpt: at most `excerptLimit` units, cut at a line end when it can be.
    static func excerpt(_ text: String) -> CodeExcerpt {
        let units = text as NSString
        guard units.length > excerptLimit else { return CodeExcerpt(text: text, cut: false) }
        let head = units.substring(to: excerptLimit) as NSString
        let lineEnd = head.range(of: "\n", options: [.literal, .backwards]).location
        return CodeExcerpt(text: lineEnd != NSNotFound && lineEnd > 0 ? head.substring(to: lineEnd) : head as String, cut: true)
    }

    private static func place(in text: NSString, at offset: Int) -> TextPlace {
        var line = 0, from = 0
        var next = text.range(of: "\n", options: .literal, range: NSRange(location: 0, length: text.length)).location
        while next != NSNotFound, next < offset {
            line += 1
            from = next + 1
            next = text.range(of: "\n", options: .literal, range: NSRange(location: from, length: text.length - from)).location
        }
        return TextPlace(line: line, column: offset - from)
    }

    /// The one place `excerpt` occurs in `text`; nil when it is absent or there twice.
    static func findOnce(_ text: String, _ excerpt: String) -> TextSpan? {
        guard !excerpt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let units = text as NSString
        let found = units.range(of: excerpt, options: .literal)
        guard found.location != NSNotFound else { return nil }
        let after = found.location + 1
        if units.range(of: excerpt, options: .literal, range: NSRange(location: after, length: units.length - after)).location != NSNotFound { return nil }
        return TextSpan(start: place(in: units, at: found.location), end: place(in: units, at: found.location + found.length))
    }

    // MARK: Through a rewrite

    /// The last line a span uses: a span ending at a line's start stops on the line before.
    private static func lastLine(_ span: TextSpan) -> Int {
        span.end.column == 0 && span.end.line > span.start.line ? span.end.line - 1 : span.end.line
    }

    /// What stands on a range's own lines around it: before its start and after its end.
    private static func beside(_ lines: [String], _ span: TextSpan) -> [String] {
        let line = { (index: Int) in index < lines.count ? lines[index] : "" }
        return [slice(line(span.start.line), from: 0, to: span.start.column), slice(line(span.end.line), from: span.end.column)]
    }

    /// An outdated point at the nearest line the range had.
    private static func outdated(_ span: TextSpan, _ lines: [String]) -> Anchored {
        let line = min(span.start.line, max(0, lines.count - 1))
        let length = line < lines.count ? (lines[line] as NSString).length : 0
        let point = TextPlace(line: line, column: min(span.start.column, length))
        return Anchored(span: TextSpan(start: point, end: point), outdated: true)
    }

    /// A range after its file's whole text changed from `before` to `after`: kept when the change
    /// is all below it, shifted when all above it, and otherwise found again by its exact text when
    /// that is the one copy in both texts, between the same text on its lines. Anything else is
    /// outdated at the nearest line it had.
    static func reanchor(_ span: TextSpan, excerpt: String, cut: Bool, before: [String], after: [String]) -> Anchored {
        let shortest = min(before.count, after.count)
        var prefix = 0
        while prefix < shortest, same(before[prefix], after[prefix]) { prefix += 1 }
        var suffix = 0
        while suffix < shortest - prefix, same(before[before.count - 1 - suffix], after[after.count - 1 - suffix]) { suffix += 1 }
        if lastLine(span) < prefix { return Anchored(span: span, outdated: false) }
        if span.start.line >= before.count - suffix {
            let grown = after.count - before.count
            return Anchored(span: TextSpan(start: TextPlace(line: span.start.line + grown, column: span.start.column),
                                           end: TextPlace(line: span.end.line + grown, column: span.end.column)), outdated: false)
        }
        if !cut, let found = findOnce(after.joined(separator: "\n"), excerpt),
           findOnce(before.joined(separator: "\n"), excerpt) != nil,
           same(beside(before, span), beside(after, found)) {
            return Anchored(span: found, outdated: false)
        }
        return outdated(span, after)
    }

    /// A stored range against the text an editor opened with: kept when its code is still there,
    /// found again when it moved, outdated when it is gone.
    static func verify(_ span: TextSpan, excerpt: String, cut: Bool, lines: [String]) -> Anchored {
        let inRange = span.end.line < lines.count || (span.end.line == lines.count && span.end.column == 0)
        if inRange {
            let here = text(of: span, in: lines)
            if cut ? starts(here, with: excerpt) : same(here, excerpt) { return Anchored(span: span, outdated: false) }
        }
        if !cut, let found = findOnce(lines.joined(separator: "\n"), excerpt) { return Anchored(span: found, outdated: false) }
        return outdated(span, lines)
    }
}
