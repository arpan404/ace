import SwiftUI

/// Shared by the first message and follow-ups so their keyboard and control layout agree.
struct ComposerSurface<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none, content: content)
            .padding(.vertical, AceTheme.Spacing.sm)
            .floatingGlass()
    }
}

struct ComposerActionButton: View {
    var stopping = false
    var saving = false
    let disabled: Bool
    let label: String
    let action: () -> Void
    @Environment(\.colorScheme) private var colourScheme
    var body: some View {
        Button(action: action) {
            Group {
                if saving { ProgressView().tint(AceTheme.Colours.background) }
                else { Image(systemName: stopping ? "stop.fill" : "arrow.up").aceFont(AceTheme.Typography.title, relativeTo: .body) }
            }
            .frame(width: AceTheme.Spacing.xxxl, height: AceTheme.Spacing.xxxl)
            .foregroundStyle(AceTheme.Colours.background)
            .background(AceTheme.Colours.foreground, in: Circle())
            .opacity(disabled && !saving ? AceTheme.Opacity.disabled(colourScheme) : 1)
            .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).accessibilityLabel(label)
    }
}
