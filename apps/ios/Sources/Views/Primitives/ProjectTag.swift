import SwiftUI

/// A project's two-letter tag ("BA", "RE"), the shared `projectBadge` initials the bridge sends,
/// on a small `rounded-xs` fill in muted ink. Identity is monochrome: no tint. `quiet` (settled
/// rows) drops the letters to the faint tier. Decorative: the project name sits beside it.
struct ProjectTag: View {
    let initials: String
    var quiet = false
    @ScaledMetric(relativeTo: .caption2) private var height: CGFloat = 17
    @ScaledMetric(relativeTo: .caption2) private var width: CGFloat = 21

    var body: some View {
        Text(initials.uppercased())
            .font(.system(size: height * 0.62, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(quiet ? AceTheme.Colours.faintForeground : AceTheme.Colours.mutedForeground)
            .frame(minWidth: width, minHeight: height, maxHeight: height)
            .padding(.horizontal, initials.count > 2 ? AceTheme.Spacing.xxs : 0)
            .background(AceTheme.Colours.fill, in: AceShape.capsule)
            .accessibilityHidden(true)
    }
}
