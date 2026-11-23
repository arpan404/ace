import SwiftUI

/// A store shelf uses one column, as the web Store does at phone widths.
struct MarketShelf<Item: Identifiable, Row: View>: View {
    let title: String
    var line: String? = nil
    let items: [Item]
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                MarketShelfHeader(title: title, line: line)
                LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    ForEach(items) { row($0) }
                }
                .padding(.horizontal, AceDesign.Space.margin)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(title)
        }
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
