import Markit
import UIKit

/// A file's grammar colours from markit, read off the main thread so a file opens at once and
/// colours in a moment later: each run's text colour (and a diff's line tints), over UTF-16
/// ranges of the exact text asked about. Colours follow the appearance on their own. Text past
/// `limit`, or colouring past `runLimit` runs, stays plain: its colours would cost more than they
/// help, as on the web's viewer.
struct SourceColours: @unchecked Sendable {
    // UIColor is immutable; the ranges are plain values.
    struct Run {
        let range: NSRange
        let key: NSAttributedString.Key
        let colour: UIColor
    }
    /// The most text coloured, in UTF-16 units.
    static let limit = 256 * 1024
    static let runLimit = 120_000
    /// Runs laid over the text per main-thread turn, so a large file never holds a frame.
    static let batch = 4_000

    let length: Int
    let runs: [Run]

    /// The colours of `text` in `language`, or nil when it shows plain. Runs on the concurrent
    /// pool, never the caller's actor, and gives up once the caller's task is cancelled.
    @concurrent static func read(_ text: String, language: String, theme: MarkitTheme) async -> SourceColours? {
        let length = (text as NSString).length
        guard length <= limit, !Task.isCancelled,
              let coloured = try? Markit.highlightedText(source: text, language: language, theme: theme),
              // The colours must spell the text exactly, or they would land on the wrong characters.
              coloured.length == length, !Task.isCancelled else { return nil }
        var runs: [Run] = []
        let whole = NSRange(location: 0, length: length)
        for key in [NSAttributedString.Key.foregroundColor, .backgroundColor] {
            coloured.enumerateAttribute(key, in: whole) { value, range, stop in
                if let colour = value as? UIColor { runs.append(Run(range: range, key: key, colour: colour)) }
                if runs.count > runLimit { stop.pointee = true }
            }
        }
        guard !runs.isEmpty, runs.count <= runLimit, !Task.isCancelled else { return nil }
        return SourceColours(length: length, runs: runs)
    }

    /// Lays the colours over `storage` a batch per main-thread turn, while `current` says the
    /// storage still holds the text they were read for.
    @MainActor func apply(to storage: NSTextStorage, while current: () -> Bool) async {
        var start = 0
        while start < runs.count {
            guard storage.length == length, current(), !Task.isCancelled else { return }
            storage.beginEditing()
            for run in runs[start..<min(start + Self.batch, runs.count)] {
                storage.addAttribute(run.key, value: run.colour, range: run.range)
            }
            storage.endEditing()
            start += Self.batch
            await Task.yield()
        }
    }
}
