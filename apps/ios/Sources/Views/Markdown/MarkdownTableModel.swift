import Markit
import SwiftUI
import UIKit

/// A table's cells as markit reads them, rows and columns counted from zero in reading order,
/// with each column's natural and minimum widths for `MarkdownTableColumns`. A table markit can't
/// read (or not yet, mid-stream) is one cell holding its source. Math in a cell is drawn as markit
/// draws it, an image in the line, not its TeX.
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
    /// A stretch of a cell: styled text, or markit's picture of a formula at its size, set
    /// `baseline` points off the line's baseline.
    enum Run {
        case text(AttributedString)
        case math(UIImage, baseline: CGFloat)
    }
    struct Cell {
        let row: Int
        let column: Int
        let header: Bool
        let alignment: Alignment
        let runs: [Run]
        /// What VoiceOver reads: the text, with each formula as its source.
        let spoken: String
        var hasMath: Bool { runs.contains { if case .math = $0 { true } else { false } } }
    }
    /// A cell with its widths measured: on one line, and its widest unbreakable piece, padding
    /// included.
    struct Measured {
        var cell: Cell
        let natural: CGFloat
        let minimum: CGFloat
    }
    let cells: [Cell]
    let rows: Int
    let columns: Int
    /// Each column's widest cell on one line, and its widest unbreakable piece, padding included.
    let natural: [CGFloat]
    let minimum: [CGFloat]

    /// The narrowest a column gets, so an empty one still shows as a column.
    static let minColumnWidth: CGFloat = 44

    /// The whole table read at once.
    @MainActor init(source: String, flavor: MarkitFlavor, theme: MarkitTheme, traits: UITraitCollection) {
        let read = Self.read(source, flavor: flavor, theme: theme, traits: traits)
        self.init(measured: read?.cells ?? [Self.unread(source, theme: theme, traits: traits)], rows: read?.rows ?? 1)
    }

    init(measured: [Measured], rows: Int) {
        let count = (measured.map(\.cell.column).max() ?? 0) + 1
        var natural = [CGFloat](repeating: Self.minColumnWidth, count: count)
        var minimum = [CGFloat](repeating: Self.minColumnWidth, count: count)
        for each in measured {
            natural[each.cell.column] = max(natural[each.cell.column], each.natural)
            minimum[each.cell.column] = max(minimum[each.cell.column], each.minimum)
        }
        cells = measured.map(\.cell)
        self.rows = rows
        columns = count
        self.natural = natural
        self.minimum = minimum
    }

    /// The cells markit reads in `source`, measured, rows counted from zero; nil when it reads no
    /// table there.
    @MainActor static func read(_ source: String, flavor: MarkitFlavor, theme: MarkitTheme,
                                traits: UITraitCollection) -> (cells: [Measured], rows: Int)? {
        guard let document = try? Markit.parse(source, flavor: flavor) else { return nil }
        let spans = document.spans.filter { $0.kind == "table_cell" && $0.end >= $0.start }
        guard !spans.isEmpty else { return nil }
        let pad = theme.tableCellInsets.left + theme.tableCellInsets.right
        let rowIndex = Dictionary(uniqueKeysWithValues: Set(spans.map { $0.row ?? 0 }).sorted().enumerated().map { ($0.element, $0.offset) })
        let cells = spans.map { span in
            let drawn = document.attributedString(in: span.range, theme: theme, traits: traits)
            let text = document.attributedText(in: span.range, theme: theme, traits: traits)
            let cell = Cell(row: rowIndex[span.row ?? 0] ?? 0, column: max(0, span.column ?? 0), header: span.header ?? false,
                            alignment: span.alignment == "right" ? .trailing : span.alignment == "center" ? .center : .leading,
                            runs: runs(drawn, text).map { run in if case .text(let piece) = run { .text(breakable(piece)) } else { run } },
                            spoken: String(text.characters))
            return Measured(cell: cell, natural: width(of: drawn) + pad, minimum: widestPiece(of: drawn) + pad)
        }
        return (cells, rowIndex.count)
    }

    /// `source` as one cell, for a table markit doesn't read.
    @MainActor static func unread(_ source: String, theme: MarkitTheme, traits: UITraitCollection) -> Measured {
        let pad = theme.tableCellInsets.left + theme.tableCellInsets.right
        let drawn = NSAttributedString(string: source, attributes: [.font: theme.tableFont.font(compatibleWith: traits)])
        let cell = Cell(row: 0, column: 0, header: false, alignment: .leading, runs: [.text(AttributedString(source))], spoken: source)
        return Measured(cell: cell, natural: width(of: drawn) + pad, minimum: widestPiece(of: drawn) + pad)
    }

    /// A cell's runs: `text` as markit converts it for SwiftUI (formulas as their source), with
    /// each formula `drawn` holds as an image put back in its place. The two are walked side by
    /// side: each of `drawn`'s runs is its text in `text`, a formula its source.
    static func runs(_ drawn: NSAttributedString, _ text: AttributedString) -> [Run] {
        var runs: [Run] = []
        let characters = text.characters
        var cursor = characters.startIndex
        var pending = cursor
        let string = drawn.string as NSString
        func advance(_ count: Int) {
            cursor = characters.index(cursor, offsetBy: count, limitedBy: characters.endIndex) ?? characters.endIndex
        }
        drawn.enumerateAttributes(in: NSRange(location: 0, length: drawn.length)) { attributes, range, _ in
            let raw = attributes[.markitRaw] as? String
            let attachment = attributes[.attachment] as? NSTextAttachment
            if let raw, let attachment, let image = attachment.image {
                if pending < cursor { runs.append(.text(AttributedString(text[pending..<cursor]))) }
                runs.append(.math(sized(image, to: attachment.bounds.size), baseline: attachment.bounds.minY))
                advance(raw.count)
                pending = cursor
            } else {
                advance((raw ?? (attachment == nil ? string.substring(with: range) : "")).count)
            }
        }
        if pending < characters.endIndex { runs.append(.text(AttributedString(text[pending...]))) }
        return runs
    }

    /// `image` drawn at `size`, the size markit gives the formula in the line.
    private static func sized(_ image: UIImage, to size: CGSize) -> UIImage {
        guard size.width > 0, size.height > 0, size != image.size else { return image }
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
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
