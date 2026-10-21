import SwiftUI

/// DESIGN.md §3 "Empty state", centred: a faint icon, the title (500), one muted line, and at
/// most one secondary action. The error state is the same anatomy with the failed glyph: its line
/// says what happened, then what to do.
struct EmptyState<Action: View>: View {
    let icon: AceIcon.Name?
    let title: String
    var line: String?
    var failed = false
    @ViewBuilder var action: () -> Action

    var body: some View {
        VStack(spacing: AceTheme.Spacing.xs) {
            if failed {
                StatusGlyph(.failed, tone: .failed, size: 24).padding(.bottom, AceTheme.Spacing.sm)
            } else if let icon {
                AceIcon(icon, size: 28, relativeTo: .title2)
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
                .buttonStyle(.bordered)
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
