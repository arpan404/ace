import Foundation

/// A long paste (a log, a file's contents) goes with the message as a text file instead of
/// flooding the field; a short one is typed in as usual. The web's rule
/// (`apps/web/src/features/thread/composer/large-paste.ts`), with the same limits and names. Pure.
enum LargePaste {
    /// UTF-16 units past which a paste becomes a file, as the web counts a string's length.
    static let maxInlineChars = 2_048
    /// Lines past which a paste becomes a file.
    static let maxInlineLines = 40

    struct File: Equatable, Sendable {
        let name: String
        let lines: Int
    }

    /// The text file a paste becomes, or nil to paste it as words.
    static func file(for text: String) -> File? {
        let lines = lineCount(text)
        if text.utf16.count <= maxInlineChars && lines <= maxInlineLines { return nil }
        return File(name: name(lines), lines: lines)
    }

    /// Whether a file is one a paste became, by its name.
    static func isPasted(_ name: String) -> Bool {
        name.wholeMatch(of: /Pasted \d+ lines?\.txt/) != nil
    }

    private static func name(_ lines: Int) -> String { "Pasted \(lines) \(lines == 1 ? "line" : "lines").txt" }

    /// Lines as the web counts them: one trailing `\n` or `\r\n` ends the last line, every other
    /// `\n` starts one. Counted in UTF-16 units, where `\r\n` is two, not one Character.
    private static func lineCount(_ text: String) -> Int {
        let units = text.utf16
        var end = units.endIndex
        if end > units.startIndex, units[units.index(before: end)] == newline {
            end = units.index(before: end)
            if end > units.startIndex, units[units.index(before: end)] == carriageReturn { end = units.index(before: end) }
        }
        return units[units.startIndex..<end].reduce(1) { $1 == newline ? $0 + 1 : $0 }
    }
    private static let newline: UInt16 = 0x0A
    private static let carriageReturn: UInt16 = 0x0D
}
