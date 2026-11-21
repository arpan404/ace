import Markit
import SwiftUI
import UIKit

/// A Markdown table as ace draws it: markit reads the table and styles each cell's text (code,
/// links, emphasis) in the page's theme, and ace lays the cells out to fit the width it is
/// offered (`MarkdownTableColumns`): short columns at their natural width, prose wrapping in the
/// rest, inline code breaking inside its paths. Only a table whose words alone are wider than
/// the room scrolls sideways, inside its box, which never reaches past the width offered.
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
        MarkdownTableBox(natural: table.natural, minimum: table.minimum) {
            ScrollView(.horizontal) {
                MarkdownTableGrid(cells: table.cells.map { .init(row: $0.row, column: $0.column) },
                                  natural: table.natural, minimum: table.minimum) {
                    // The scroller's own width, read in the same pass: the room the columns fit.
                    Color.clear.frame(height: 0).containerRelativeFrame(.horizontal).accessibilityHidden(true)
                    ForEach(table.cells.indices, id: \.self) { index in
                        cell(table.cells[index], last: table.cells[index].row == table.rows - 1, border: border)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color(uiColor: theme.codeBlockBackground), in: corner)
            .clipShape(corner)
            .overlay(corner.strokeBorder(border, lineWidth: 1))
        }
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

/// The table's box: as wide as its columns at the width offered, and never wider than that
/// width, so a table that has to scroll does so inside the page's margins.
struct MarkdownTableBox: Layout {
    let natural: [CGFloat]
    let minimum: [CGFloat]
    /// The room assumed when none is offered (an ideal size), as markit assumes.
    static let unoffered: CGFloat = 320

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = boxWidth(proposal.width)
        let height = subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: nil)).height ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }

    private func boxWidth(_ offered: CGFloat?) -> CGFloat {
        let room = offered.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? Self.unoffered
        return min(room, MarkdownTableColumns.widths(natural: natural, minimum: minimum, available: room).reduce(0, +))
    }
}

/// Lays a table's cells out on a grid, columns as `MarkdownTableColumns` sizes them for the room
/// its first subview (the scroller's width) reports, each row as tall as its tallest cell at
/// those widths. Every cell gets its column's width and its row's height, so a row's backgrounds
/// and rules line up.
struct MarkdownTableGrid: Layout {
    struct Place { let row: Int; let column: Int }
    let cells: [Place]
    let natural: [CGFloat]
    let minimum: [CGFloat]

    struct Metrics {
        var room: CGFloat
        var widths: [CGFloat]
        var heights: [CGFloat]
    }

    func makeCache(subviews: Subviews) -> Metrics? { nil }
    func updateCache(_ cache: inout Metrics?, subviews: Subviews) { cache = nil }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics?) -> CGSize {
        let metrics = measured(subviews, cache: &cache)
        return CGSize(width: metrics.widths.reduce(0, +), height: metrics.heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics?) {
        let metrics = measured(subviews, cache: &cache)
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: .zero)
        let lefts = Self.offsets(metrics.widths), tops = Self.offsets(metrics.heights)
        for (subview, place) in zip(subviews.dropFirst(), cells) where place.column < lefts.count && place.row < tops.count {
            subview.place(at: CGPoint(x: bounds.minX + lefts[place.column], y: bounds.minY + tops[place.row]), anchor: .topLeading,
                          proposal: ProposedViewSize(width: metrics.widths[place.column], height: metrics.heights[place.row]))
        }
    }

    /// Measured once per room and cells, not on every pass: a sideways scroll lays out nothing.
    private func measured(_ subviews: Subviews, cache: inout Metrics?) -> Metrics {
        let probed = subviews.first?.sizeThatFits(.unspecified).width ?? 0
        // No width read: the natural widths, scrolled if need be.
        let room = probed.isFinite && probed > 0 ? probed : .infinity
        if let cache, cache.room == room { return cache }
        let widths = MarkdownTableColumns.widths(natural: natural, minimum: minimum, available: room)
        let rows = (cells.map(\.row).max() ?? -1) + 1
        var heights = [CGFloat](repeating: 0, count: rows)
        for (subview, place) in zip(subviews.dropFirst(), cells) where place.column < widths.count {
            let height = subview.sizeThatFits(ProposedViewSize(width: widths[place.column], height: nil)).height
            heights[place.row] = max(heights[place.row], ceil(height))
        }
        let metrics = Metrics(room: room, widths: widths, heights: heights)
        cache = metrics
        return metrics
    }

    private static func offsets(_ sizes: [CGFloat]) -> [CGFloat] {
        var at: CGFloat = 0
        return sizes.map { size in defer { at += size }; return at }
    }
}
