import SwiftUI

/// The app in miniature, drawn in one theme's and accent's own colours in one scheme: a title,
/// three thread rows and the composer with its send button. Picker cards show it (DESIGN.md
/// Picker card); it never reads the colours on screen, so every choice previews as itself.
struct ThemePreview: View {
    let theme: String
    let accent: String
    let scheme: ColorScheme
    static let height: CGFloat = 104
    static let radius = AceTheme.Radii.lg

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            AceShape.capsule.fill(colour("foreground")).frame(width: 30, height: 4).padding(.bottom, AceTheme.Spacing.xxs)
            ForEach(0..<3, id: \.self) { row in thread(row) }
            Spacer(minLength: 0)
            composer
        }
        .padding(AceTheme.Spacing.sm)
        .frame(maxWidth: .infinity, minHeight: Self.height, maxHeight: Self.height)
        .background(colour("background"))
        .clipShape(RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Self.radius, style: .continuous).strokeBorder(colour("separator"), lineWidth: AceTheme.Dimensions.border))
        // Status colours are the same in every theme; they resolve in the preview's scheme.
        .environment(\.colorScheme, scheme)
        .accessibilityHidden(true)
    }

    private func thread(_ row: Int) -> some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Circle().fill(row == 0 ? AceTheme.Status.working : colour("decoration")).frame(width: 4, height: 4)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                AceShape.capsule.fill(colour("foreground")).frame(width: [34, 26, 30][row], height: 3)
                AceShape.capsule.fill(colour("mutedForeground")).frame(width: [22, 28, 18][row], height: 2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, AceTheme.Spacing.xs)
        .frame(height: 14)
        .background(row == 0 ? colour("fill") : .clear, in: RoundedRectangle(cornerRadius: AceTheme.Radii.xs, style: .continuous))
    }

    private var composer: some View {
        HStack {
            AceShape.capsule.fill(colour("subtleForeground")).frame(width: 20, height: 2)
            Spacer(minLength: 0)
            Circle().fill(colour("accent")).frame(width: 9, height: 9)
                .overlay { AceShape.capsule.fill(colour("onAccent")).frame(width: 1.5, height: 4) }
        }
        .padding(.leading, AceTheme.Spacing.sm).padding(.trailing, AceTheme.Spacing.xxs)
        .frame(height: 13)
        .background(colour("card"), in: AceShape.capsule)
        .overlay(AceShape.capsule.strokeBorder(colour("separator"), lineWidth: AceTheme.Dimensions.border))
    }

    private func colour(_ role: String) -> Color { Self.colour(role, theme: theme, accent: accent, scheme: scheme) }
    static func colour(_ role: String, theme: String, accent: String, scheme: ColorScheme) -> Color {
        guard let pair = AceTheme.pair(role, theme: theme, accent: accent) else { return .clear }
        let value = scheme == .dark ? pair.dark : pair.light
        return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
}

/// A Mode or Theme choice: the preview is the choice, its name centred below; the chosen one
/// takes the accent ring 2pt outside its edge, concentric with it.
struct PickerCard<Preview: View>: View {
    let name: String
    let selected: Bool
    let id: String
    let action: () -> Void
    @ViewBuilder var preview: () -> Preview

    var body: some View {
        Button(action: action) {
            VStack(spacing: AceTheme.Spacing.sm) {
                preview()
                    .padding(AceTheme.Spacing.xs)
                    .overlay {
                        RoundedRectangle(cornerRadius: ThemePreview.radius + AceTheme.Spacing.xs, style: .continuous)
                            .strokeBorder(AceTheme.Colours.accent, lineWidth: 2)
                            .opacity(selected ? 1 : 0)
                    }
                Text(name)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .fontWeight(selected ? .medium : .regular)
                    .foregroundStyle(selected ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(id)
    }
}
