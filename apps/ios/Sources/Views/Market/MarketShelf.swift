import SwiftUI

/// A titled shelf of the store (spec item 27): its rows three to a column, the columns scrolling
/// sideways a page at a time with the next one peeking in. At accessibility text sizes the shelf
/// becomes a plain vertical list, so no row is squeezed.
struct MarketShelf<Item: Identifiable, Row: View>: View {
    let title: String
    var line: String? = nil
    let items: [Item]
    @ViewBuilder let row: (Item) -> Row
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Rows a column holds.
    private static var perColumn: Int { 3 }

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                MarketShelfHeader(title: title, line: line)
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                        ForEach(items) { row($0) }
                    }
                    .padding(.horizontal, AceDesign.Space.margin)
                } else {
                    sideways
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(title)
        }
    }

    private var sideways: some View {
        ScrollView(.horizontal) {
            LazyHStack(alignment: .top, spacing: AceDesign.Space.margin) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        ForEach(Array(column.enumerated()), id: \.element.id) { index, item in
                            row(item)
                            if index < column.count - 1 { Divider() }
                        }
                    }
                    .containerRelativeFrame(.horizontal) { width, _ in
                        items.count > Self.perColumn ? width - 2 * AceDesign.Space.margin - AceDesign.Space.group : width - 2 * AceDesign.Space.margin
                    }
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
        .contentMargins(.horizontal, AceDesign.Space.margin, for: .scrollContent)
    }

    private var columns: [[Item]] {
        stride(from: 0, to: items.count, by: Self.perColumn).map { Array(items[$0..<min($0 + Self.perColumn, items.count)]) }
    }
}

/// A shelf's or section's title, its one line under it, and a trailing control.
struct MarketShelfHeader<Trailing: View>: View {
    let title: String
    var line: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                Text(title).aceFont(AceDesign.TextRole.header).foregroundStyle(AceDesign.Ink.primary)
                    .accessibilityAddTraits(.isHeader)
                if let line, !line.isEmpty {
                    Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            trailing()
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }
}

extension MarketShelfHeader where Trailing == EmptyView {
    init(title: String, line: String? = nil) {
        self.init(title: title, line: line) { EmptyView() }
    }
}
