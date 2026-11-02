import SwiftUI

/// DESIGN.md §3 "Empty state", centred: a faint icon, the title (500), one muted line, and at
/// most one secondary action. The error state is the same anatomy with the failed glyph: its line
/// says what happened, then what to do.
struct EmptyState<Action: View>: View {
    let icon: AceIcon.Name?
    let title: String
    var line: String?
    var failed = false
    /// An SF Symbol where the app has no glyph of its own for the place.
    var symbol: String? = nil
    @ViewBuilder var action: () -> Action

    var body: some View {
        VStack(spacing: AceTheme.Spacing.xs) {
            if failed {
                StatusGlyph(.failed, tone: .failed, size: 24).padding(.bottom, AceTheme.Spacing.sm)
            } else if let icon {
                AceIcon(icon, size: 28, relativeTo: .title2)
                    .foregroundStyle(AceTheme.Colours.faintForeground)
                    .padding(.bottom, AceTheme.Spacing.sm)
            } else if let symbol {
                Image(systemName: symbol).font(.title2)
                    .foregroundStyle(AceTheme.Colours.faintForeground)
                    .padding(.bottom, AceTheme.Spacing.sm)
            }
            Text(title)
                .aceFont(AceTheme.Typography.label, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
            if let line {
                Text(line)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            action()
                .buttonStyle(.bordered).buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.foreground)
                .padding(.top, AceTheme.Spacing.sm)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
        .padding(.horizontal, AceTheme.Spacing.xl)
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

