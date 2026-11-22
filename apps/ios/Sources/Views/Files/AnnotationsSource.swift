import UIKit

/// The source view's side of code notes: a selection as a range of lines and UTF-16 columns,
/// an edit as the range it replaced, and the lines a note's text is read from.
extension SourceTextView {
    /// New text loaded with notes on the file: they find their code once this update is done.
    static func tell(_ loaded: @escaping @MainActor ([String]?, [String]) -> Void, earlier: String?, now: String) {
        Task { @MainActor in loaded(earlier.map(AnnotationAnchor.lines), AnnotationAnchor.lines(now)) }
    }
}

extension SourceTextView.Coordinator {
    /// The selection as a range, when there is one.
    func span(_ textView: UITextView) -> TextSpan? {
        let range = textView.selectedRange
        guard range.length > 0, let container = textView.superview?.superview as? SourceContainer else { return nil }
        return TextSpan(start: container.place(at: range.location), end: container.place(at: range.location + range.length))
    }
}

extension SourceContainer {
    /// The line and UTF-16 column of `offset` in the text as it is now.
    func place(at offset: Int) -> TextPlace {
        let line = lineIndex(at: offset)
        return TextPlace(line: line, column: offset - lineStarts[line])
    }

    /// What replacing `range` with `typed` does, measured in the text before it lands.
    func replacement(_ range: NSRange, with typed: String) -> TextReplacement {
        TextReplacement.replacing(from: place(at: range.location), to: place(at: range.location + range.length), with: typed)
    }

    /// A 0-based line's text without its break; empty past the end.
    func lineText(_ index: Int) -> String {
        guard index >= 0, index < lineStarts.count else { return "" }
        let storage = text.textStorage.string as NSString
        let start = lineStarts[index]
        let end = index + 1 < lineStarts.count ? lineStarts[index + 1] - 1 : storage.length
        return storage.substring(with: NSRange(location: start, length: max(0, min(end, storage.length) - start)))
    }
}
