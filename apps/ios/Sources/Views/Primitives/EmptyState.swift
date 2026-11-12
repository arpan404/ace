import SwiftUI

/// DESIGN.md §3 "Empty state", centred: a faint icon, the title, one muted line, and at
/// most one action, as a word (design language §5: actions are words, never a filled pill). The
/// error state drops the icon: one sentence in the failed colour, a line of why, its way out.
struct EmptyState<Action: View>: View {
    let icon: AceIcon.Name?
    let title: String
    var line: String?
    var failed = false
    /// An SF Symbol where the app has no glyph of its own for the place.
    var symbol: String? = nil
    @ViewBuilder var action: () -> Action

    var body: some View {
        VStack(spacing: AceDesign.Space.tight) {
            if failed {
                EmptyView()
            } else if let icon {
                AceIcon(icon, size: AceDesign.Size.emptyIcon, relativeTo: .title2)
                    .foregroundStyle(AceDesign.Ink.faint)
                    .padding(.bottom, AceDesign.Space.related)
            } else if let symbol {
                Image(systemName: symbol).font(.title2)
                    .foregroundStyle(AceDesign.Ink.faint)
                    .padding(.bottom, AceDesign.Space.related)
            }
            Text(title)
                .font(AceDesign.Typeface.body)
                .foregroundStyle(failed ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
            if let line {
                Text(line)
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            action()
                .buttonStyle(.textAction(.prominent))
                .padding(.top, AceDesign.Space.tight)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: AceDesign.Size.emptyWidth)
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}

extension EmptyState where Action == EmptyView {
    init(icon: AceIcon.Name?, title: String, line: String? = nil, failed: Bool = false) {
        self.init(icon: icon, title: title, line: line, failed: failed) { EmptyView() }
    }
}

extension EmptyState {
    /// The same empty state with an SF Symbol.
    init(systemImage: String, title: String, line: String? = nil, failed: Bool = false, @ViewBuilder action: @escaping () -> Action) {
        self.init(icon: nil, title: title, line: line, failed: failed, symbol: systemImage, action: action)
    }
}

extension EmptyState where Action == EmptyView {
    init(systemImage: String, title: String, line: String? = nil, failed: Bool = false) {
        self.init(icon: nil, title: title, line: line, failed: failed, symbol: systemImage) { EmptyView() }
    }
    /// A search that found nothing: what was searched, and what to try.
    static func search(_ text: String) -> EmptyState<EmptyView> {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return EmptyState(systemImage: "magnifyingglass", title: query.isEmpty ? "No results" : "No results for “\(query)”",
                          line: "Check the spelling or try another search.")
    }
}

