import Markit
import UIKit

/// A file's grammar colours from markit, read off the main thread so a large file opens at once
/// and colours in a moment later: each run's text colour (and a diff's line tints), over UTF-16
/// ranges of the exact text asked about. Colours follow the appearance on their own.
struct SourceColours: @unchecked Sendable {
    // UIColor is immutable; the ranges are plain values.
    struct Run {
        let range: NSRange
        let key: NSAttributedString.Key
        let colour: UIColor
    }
    let length: Int
    let runs: [Run]

    /// The colours of `text` in `language`, or nil when markit leaves it plain or can't read it.
    static func read(_ text: String, language: String, theme: MarkitTheme) async -> SourceColours? {
        await Task.detached(priority: .userInitiated) { () -> SourceColours? in
            guard let coloured = try? Markit.highlightedText(source: text, language: language, theme: theme) else { return nil }
            let length = (text as NSString).length
            // The colours must spell the text exactly, or they would land on the wrong characters.
            guard coloured.length == length, !Task.isCancelled else { return nil }
            var runs: [Run] = []
            let whole = NSRange(location: 0, length: length)
            for key in [NSAttributedString.Key.foregroundColor, .backgroundColor] {
                coloured.enumerateAttribute(key, in: whole) { value, range, _ in
                    if let colour = value as? UIColor { runs.append(Run(range: range, key: key, colour: colour)) }
                }
            }
            return runs.isEmpty ? nil : SourceColours(length: length, runs: runs)
        }.value
    }

    /// Lays the colours over `storage`, which must still hold the text they were read for.
    @MainActor func apply(to storage: NSTextStorage) {
        guard storage.length == length else { return }
        storage.beginEditing()
        for run in runs { storage.addAttribute(run.key, value: run.colour, range: run.range) }
        storage.endEditing()
    }
}
