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
    static let xxl: CGFloat = 32
}

enum AppRadius {
    static let sm: CGFloat = 10
    static let md: CGFloat = 14
    static let lg: CGFloat = 20
    static let xl: CGFloat = 28
}

extension Color {
    static let appBackground = Color(nsColor: .windowBackgroundColor).opacity(0.72)
    static let sidebarBackground = Color(nsColor: .underPageBackgroundColor).opacity(0.54)
    static let panelBackground = Color(nsColor: .controlBackgroundColor).opacity(0.46)
    static let separatorStrong = Color.primary.opacity(0.12)
    static let selectionBackground = Color.accentColor.opacity(0.20)
    static let hoverBackground = Color.primary.opacity(0.07)
    static let userBubbleBackground = Color.accentColor.opacity(0.18)
    static let assistantBubbleBackground = Color.primary.opacity(0.055)
    static let glassStroke = Color.white.opacity(0.28)
    static let glassInnerStroke = Color.primary.opacity(0.08)
    static let glassHighlight = Color.white.opacity(0.18)
    static let chromeTint = Color(nsColor: .controlAccentColor).opacity(0.12)
}

struct LiquidGlassBackground: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(.regularMaterial)

            LinearGradient(
                colors: [
                    Color.accentColor.opacity(0.16),
                    Color.cyan.opacity(0.08),
                    Color.indigo.opacity(0.10),
                    Color.clear,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .blendMode(.softLight)

            LinearGradient(
                colors: [
                    Color.white.opacity(0.20),
                    Color.clear,
                    Color.black.opacity(0.08),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
    }
}

struct GlassPanel: ViewModifier {
    var radius: CGFloat = AppRadius.lg
    var tint: Color = .clear
    var elevated = false

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(tint)
                    .overlay(alignment: .topLeading) {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [Color.glassHighlight, .clear],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .blendMode(.screen)
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.glassStroke, lineWidth: 0.8)
                    .overlay {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .strokeBorder(Color.glassInnerStroke, lineWidth: 0.6)
                    }
            }
            .shadow(color: Color.black.opacity(elevated ? 0.18 : 0.08), radius: elevated ? 24 : 12, y: elevated ? 14 : 6)
    }
}

extension View {
    func glassPanel(
        radius: CGFloat = AppRadius.lg,
        tint: Color = .clear,
        elevated: Bool = false
    ) -> some View {
        modifier(GlassPanel(radius: radius, tint: tint, elevated: elevated))
    }
}

struct GlassDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.separatorStrong)
            .frame(height: 1)
            .overlay(Color.white.opacity(0.18))
    }
}

struct AppSectionLabel: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .tracking(0.9)
            .padding(.horizontal, AppSpacing.sm)
    }
}

struct IconButton: View {
    let title: String
    let icon: AppIcon
    var prominent = false
    let action: () -> Void

    var body: some View {
        Group {
            if #available(macOS 26.0, *) {
                if prominent {
                    Button(action: action) {
                        label
                    }
                    .buttonStyle(.glassProminent)
                } else {
                    Button(action: action) {
                        label
                    }
                    .buttonStyle(.glass)
                }
            } else {
                Button(action: action) {
                    label
                }
                .buttonStyle(.plain)
                .background(prominent ? Color.selectionBackground : Color.panelBackground.opacity(0.48))
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
            }
        }
        .foregroundStyle(prominent ? Color.accentColor : Color.secondary)
        .help(title)
    }

    private var label: some View {
        icon.image
            .font(.system(size: 14, weight: .semibold))
            .frame(width: 30, height: 30)
            .contentShape(Rectangle())
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
            .background(.thinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                    .strokeBorder(Color.glassInnerStroke, lineWidth: 0.6)
            }
    }
}
