import SwiftUI

enum AppFocus: Hashable {
    case sidebar
    case composer
}

enum AppSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
}

enum AppRadius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 8
    static let lg: CGFloat = 12
}

extension Color {
    static let appBackground = Color(nsColor: .windowBackgroundColor)
    static let sidebarBackground = Color(nsColor: .underPageBackgroundColor)
    static let panelBackground = Color(nsColor: .controlBackgroundColor)
    static let separatorStrong = Color.primary.opacity(0.10)
    static let selectionBackground = Color.accentColor.opacity(0.18)
    static let hoverBackground = Color.primary.opacity(0.06)
    static let userBubbleBackground = Color.accentColor.opacity(0.14)
    static let assistantBubbleBackground = Color.primary.opacity(0.045)
}

struct AppSectionLabel: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .tracking(0.7)
            .padding(.horizontal, AppSpacing.sm)
    }
}

struct IconButton: View {
    let title: String
    let icon: AppIcon
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            icon.image
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(prominent ? Color.accentColor : Color.secondary)
        .background(prominent ? Color.selectionBackground : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm))
        .help(title)
    }
}

struct ShortcutHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.panelBackground)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm))
    }
}
