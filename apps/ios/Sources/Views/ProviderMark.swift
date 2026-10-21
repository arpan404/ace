import SwiftUI

/// The agent provider beside a model name or on a subagent avatar. Brand marks need a native
/// path renderer for `@ace/ui-core/provider-icons`; until then a neutral monogram stands in, never
/// a lookalike of anyone's logo.
struct ProviderMark: View {
    let provider: String
    var body: some View {
        Text(verbatim: monogram)
            .font(.caption2.weight(.heavy))
            .foregroundStyle(AceTheme.Colours.background)
            .frame(width: AceTheme.Spacing.lg + AceTheme.Spacing.xxs, height: AceTheme.Spacing.lg + AceTheme.Spacing.xxs)
            .background(AceTheme.Colours.mutedForeground, in: RoundedRectangle(cornerRadius: AceTheme.Radii.badge))
            .accessibilityHidden(true)
    }
    private var monogram: String {
        provider.isEmpty ? "·" : provider.prefix(1).uppercased()
    }
}
