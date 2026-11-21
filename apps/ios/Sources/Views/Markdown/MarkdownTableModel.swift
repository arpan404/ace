import Markit
import SwiftUI
import UIKit

/// A table's cells as markit reads them, rows and columns counted from zero in reading order,
/// with each column's natural and minimum widths for `MarkdownTableColumns`. A table markit can't
/// read (or not yet, mid-stream) is one cell holding its source.
struct MarkdownTable {
    enum Alignment {
        case leading, center, trailing
        var text: TextAlignment {
            switch self { case .leading: .leading; case .center: .center; case .trailing: .trailing }
        }
        var frame: SwiftUI.Alignment {
            switch self { case .leading: .topLeading; case .center: .top; case .trailing: .topTrailing }
        }
    }
    struct Cell {
        let row: Int
        let column: Int
        let header: Bool
        let alignment: Alignment
        let text: AttributedString
    }
    let cells: [Cell]
    let rows: Int
    let columns: Int
    /// Each column's widest cell on one line, and its widest unbreakable piece, padding included.
    let natural: [CGFloat]
    let minimum: [CGFloat]

    /// The narrowest a column gets, so an empty one still shows as a column.
    static let minColumnWidth: CGFloat = 44

    @MainActor init(source: String, flavor: MarkitFlavor, theme: MarkitTheme, traits: UITraitCollection) {
        let document = try? Markit.parse(source, flavor: flavor)
        let spans = document?.spans.filter { $0.kind == "table_cell" && $0.end >= $0.start } ?? []
        let pad = theme.tableCellInsets.left + theme.tableCellInsets.right
        let texts: [NSAttributedString]
        let made: [Cell]
        if let document, !spans.isEmpty {
            let rowIndex = Dictionary(uniqueKeysWithValues: Set(spans.map { $0.row ?? 0 }).sorted().enumerated().map { ($0.element, $0.offset) })
            texts = spans.map { document.attributedString(in: $0.range, theme: theme, traits: traits) }
            made = spans.map { span in
                Cell(row: rowIndex[span.row ?? 0] ?? 0, column: max(0, span.column ?? 0), header: span.header ?? false,
                     alignment: span.alignment == "right" ? .trailing : span.alignment == "center" ? .center : .leading,
                     text: Self.breakable(document.attributedText(in: span.range, theme: theme, traits: traits)))
            }
            rows = rowIndex.count
        } else {
            texts = [NSAttributedString(string: source, attributes: [.font: theme.tableFont.font(compatibleWith: traits)])]
            made = [Cell(row: 0, column: 0, header: false, alignment: .leading, text: AttributedString(source))]
            rows = 1
        }
        let count = (made.map(\.column).max() ?? 0) + 1
        var natural = [CGFloat](repeating: Self.minColumnWidth, count: count)
        var minimum = [CGFloat](repeating: Self.minColumnWidth, count: count)
        for (cell, text) in zip(made, texts) {
            natural[cell.column] = max(natural[cell.column], Self.width(of: text) + pad)
            minimum[cell.column] = max(minimum[cell.column], Self.widestPiece(of: text) + pad)
        }
        cells = made
        columns = count
        self.natural = natural
        self.minimum = minimum
    }

    /// Where code may break besides spaces: after each of these, then anywhere if still too long.
    static let codeBreaks: Set<Character> = ["/", ".", "-", "_", ":"]

    /// Inline code with a zero-width space after each of `codeBreaks`, so `Text` can wrap a long
    /// path or host there. Code is the text markit gives a background.
    static func breakable(_ text: AttributedString) -> AttributedString {
        var output = AttributedString()
        for run in text.runs {
            let piece = AttributedString(text[run.range])
            guard run.attributes[AttributeScopes.UIKitAttributes.BackgroundColorAttribute.self] != nil else { output.append(piece); continue }
            let characters = Array(String(piece.characters))
            var broken = ""
            for (index, character) in characters.enumerated() {
                broken.append(character)
                if codeBreaks.contains(character), index < characters.count - 1 { broken.append("\u{200B}") }
            }
            output.append(AttributedString(broken, attributes: run.attributes))
        }
        return output
    }

    private static func width(of text: NSAttributedString) -> CGFloat {
        ceil(text.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
                               options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).width)
    }

    /// The widest stretch with no break: between spaces, and in code after each of `codeBreaks`.
    private static func widestPiece(of text: NSAttributedString) -> CGFloat {
        let string = text.string as NSString
        var widest: CGFloat = 0
        var start = 0
        func close(_ end: Int) {
            if end > start { widest = max(widest, width(of: text.attributedSubstring(from: NSRange(location: start, length: end - start)))) }
        }
        var index = 0
        while index < string.length {
            let range = string.rangeOfComposedCharacterSequence(at: index)
            let character = Character(string.substring(with: range))
            if character.isWhitespace {
                close(index)
                start = NSMaxRange(range)
            } else if codeBreaks.contains(character), text.attribute(.backgroundColor, at: index, effectiveRange: nil) != nil {
                close(NSMaxRange(range))
                start = NSMaxRange(range)
            }
            index = NSMaxRange(range)
        }
        close(string.length)
        return widest
    }
}
