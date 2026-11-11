import SwiftUI

/// A read that failed, as the design language draws it on an inner page or a sheet: one sentence
/// in the failed colour, at most a line of why under it, and its way out as a word. It sits over
/// the rows the read last found, which stay until the next answer arrives.
struct QuietProblemRow: View {
    let title: String
    var detail: String? = nil
    /// The action's words ("Try again"); nil when there is nothing to ask again.
    var action: String? = nil
    let identifier: String
    var run: () -> Void = {}

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(title).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            if let action {
                Button(action, action: run)
                    .buttonStyle(.textAction(.prominent))
                    .accessibilityIdentifier(identifier)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.tight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityElement(children: .contain)
    }
}
