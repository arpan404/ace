import SwiftUI

/// The one way a read or a change that failed shows, on any page, list or sheet: the sentence in
/// the failed colour, at most a line of why under it, then its way out as a button under both,
/// always in that order. It sits over the rows the read last found, which stay until the next
/// answer arrives. No box, no icon.
struct ProblemRow: View {
    let title: String
    var detail: String? = nil
    /// What a test names the sentence; several can be on one page, so each call site says which.
    var id = "service.problem"
    /// The way out's name for tests; `id` + `.retry` unless the page names it.
    var retryId: String? = nil
    /// The way out's words ("Try again", "Reload", "Allow this folder").
    var retryLabel = "Try again"
    /// Holds the way out back while what it starts is already under way.
    var disabled = false
    /// The way out; nil when there is nothing to ask again.
    var retry: (() -> Void)? = nil

    init(_ title: String, detail: String? = nil, id: String = "service.problem", retryId: String? = nil,
         retryLabel: String = "Try again", disabled: Bool = false, retry: (() -> Void)? = nil) {
        self.title = title
        self.detail = detail
        self.id = id
        self.retryId = retryId
        self.retryLabel = retryLabel
        self.disabled = disabled
        self.retry = retry
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(title).aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceTheme.StatusText.failed)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(id)
            if let detail, !detail.isEmpty {
                Text(detail).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let retry {
                Button(retryLabel, action: retry)
                    .buttonStyle(.secondaryAction)
                    .disabled(disabled)
                    .padding(.top, AceDesign.Space.tight)
                    .accessibilityIdentifier(retryId ?? "\(id).retry")
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
