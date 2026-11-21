import Markit
import SwiftUI
import UIKit

/// A Markdown table as ace draws it: markit reads the table and styles each cell's text (code,
/// links, emphasis) in the page's theme, and ace lays the cells out in a grid inside its own
/// sideways scroller. A table wider than the row slides under the finger; one that fits doesn't
/// move, so a swipe over it stays the page's. Long text and code in a cell wrap at the column's
/// widest, never past it.
struct MarkdownTableView: View, Equatable {
    let source: String
    let flavor: MarkitFlavor
    let theme: MarkitTheme
    let selectable: Bool
    let onLink: (URL) -> Void
    let onReference: (MarkitReference) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicType

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.source == rhs.source && lhs.flavor == rhs.flavor && lhs.theme == rhs.theme && lhs.selectable == rhs.selectable
    }

    var body: some View {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType))
        let table = MarkdownTable(source: source, flavor: flavor, theme: theme, traits: traits)
        let border = Color(uiColor: theme.tableBorder)
        let corner = RoundedRectangle(cornerRadius: theme.codeCornerRadius, style: .continuous)
        let open = onLink, reference = onReference
        ScrollView(.horizontal) {
            MarkdownTableGrid(cells: table.cells.map { .init(row: $0.row, column: $0.column) }, columns: table.columns,
                              maxColumnWidth: theme.tableMaxColumnWidth + theme.tableCellInsets.left + theme.tableCellInsets.right) {
                ForEach(table.cells.indices, id: \.self) { index in
                    cell(table.cells[index], last: table.cells[index].row == table.rows - 1, border: border)
                }
            }
            .background(Color(uiColor: theme.codeBlockBackground))
            .clipShape(corner)
            .overlay(corner.strokeBorder(border, lineWidth: 1))
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .fixedSize(horizontal: false, vertical: true)
        .tint(theme.linkColor.map { Color(uiColor: $0) })
        .environment(\.openURL, OpenURLAction { url in
            if let target = MarkitReference(url: url) { reference(target) } else { open(url) }
            return .handled
        })
        .accessibilityIdentifier("markdown.table")
    }

    private func cell(_ cell: MarkdownTable.Cell, last: Bool, border: Color) -> some View {
        Text(cell.text)
            .multilineTextAlignment(cell.alignment.text)
            .lineSpacing(theme.lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .modifier(Selectable(on: selectable))
            .padding(EdgeInsets(top: theme.tableCellInsets.top, leading: theme.tableCellInsets.left,
                                bottom: theme.tableCellInsets.bottom, trailing: theme.tableCellInsets.right))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: cell.alignment.frame)
            .background(cell.header ? Color(uiColor: theme.tableHeaderBackground) : Color.clear)
            .overlay(alignment: .bottom) {
                if !last { Rectangle().fill(border).frame(height: 1).accessibilityHidden(true) }
            }
            .accessibilityAddTraits(cell.header ? .isHeader : [])
    }

    /// Text selection where the text offers it; elsewhere the message's own menu has Select text.
    private struct Selectable: ViewModifier {
        let on: Bool
        func body(content: Content) -> some View {
            if on { content.textSelection(.enabled) } else { content }
        }
    }
}

/// A table's cells as markit reads them, rows and columns counted from zero in reading order.
/// A table markit can't read (or not yet, mid-stream) is one cell holding its source.
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

    @MainActor init(source: String, flavor: MarkitFlavor, theme: MarkitTheme, traits: UITraitCollection) {
        let document = try? Markit.parse(source, flavor: flavor)
        let spans = document?.spans.filter { $0.kind == "table_cell" && $0.end >= $0.start } ?? []
        guard let document, !spans.isEmpty else {
            cells = [Cell(row: 0, column: 0, header: false, alignment: .leading, text: AttributedString(source))]
            rows = 1
            columns = 1
            return
        }
        let rowIndex = Dictionary(uniqueKeysWithValues: Set(spans.map { $0.row ?? 0 }).sorted().enumerated().map { ($0.element, $0.offset) })
        cells = spans.map { span in
            Cell(row: rowIndex[span.row ?? 0] ?? 0, column: max(0, span.column ?? 0), header: span.header ?? false,
                 alignment: span.alignment == "right" ? .trailing : span.alignment == "center" ? .center : .leading,
                 text: document.attributedText(in: span.range, theme: theme, traits: traits))
        }
        rows = rowIndex.count
        columns = (cells.map(\.column).max() ?? 0) + 1
    }
}

/// Lays a table's cells out on a grid: each column as wide as its widest cell up to a limit
/// (wider text wraps there), each row as tall as its tallest cell at those widths. Every cell is
/// given its column's width and its row's height, so a row's backgrounds and rules line up.
struct MarkdownTableGrid: Layout {
    struct Place { let row: Int; let column: Int }
    let cells: [Place]
    let columns: Int
    let maxColumnWidth: CGFloat
    /// The narrowest a column gets, so an empty one still shows as a column.
    static let minColumnWidth: CGFloat = 44

    struct Metrics {
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Metrics? { nil }
    func updateCache(_ cache: inout Metrics?, subviews: Subviews) { cache = nil }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics?) -> CGSize {
        let metrics = measured(subviews, cache: &cache)
        return CGSize(width: metrics.widths.reduce(0, +), height: metrics.heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics?) {
        let metrics = measured(subviews, cache: &cache)
        let lefts = Self.offsets(metrics.widths), tops = Self.offsets(metrics.heights)
        for (subview, place) in zip(subviews, cells) where place.column < lefts.count && place.row < tops.count {
            subview.place(at: CGPoint(x: bounds.minX + lefts[place.column], y: bounds.minY + tops[place.row]), anchor: .topLeading,
                          proposal: ProposedViewSize(width: metrics.widths[place.column], height: metrics.heights[place.row]))
        }
    }

    /// Measured once per change of the cells, not on every pass (a sideways scroll lays out nothing).
    private func measured(_ subviews: Subviews, cache: inout Metrics?) -> Metrics {
        if let cache { return cache }
        let placed = Array(zip(subviews, cells))
        let widths = Self.columnWidths(cells: placed.map { (column: $0.1.column, ideal: $0.0.sizeThatFits(.unspecified).width) },
                                       columns: columns, limit: maxColumnWidth, floor: Self.minColumnWidth)
        let rows = (cells.map(\.row).max() ?? -1) + 1
        var heights = [CGFloat](repeating: 0, count: rows)
        for (subview, place) in placed where place.column < widths.count {
            let height = subview.sizeThatFits(ProposedViewSize(width: widths[place.column], height: nil)).height
            heights[place.row] = max(heights[place.row], ceil(height))
        }
        let metrics = Metrics(widths: widths, heights: heights)
        cache = metrics
        return metrics
    }

    /// Each column's width: its widest cell's own width, no wider than `limit`, no narrower than
    /// `floor`, in whole points.
    static func columnWidths(cells: [(column: Int, ideal: CGFloat)], columns: Int, limit: CGFloat, floor: CGFloat) -> [CGFloat] {
        var widths = [CGFloat](repeating: floor, count: max(0, columns))
        for cell in cells where widths.indices.contains(cell.column) {
            widths[cell.column] = max(widths[cell.column], min(limit, ceil(cell.ideal)))
        }
        return widths
    }

    private static func offsets(_ sizes: [CGFloat]) -> [CGFloat] {
        var at: CGFloat = 0
        return sizes.map { size in defer { at += size }; return at }
    }
}
