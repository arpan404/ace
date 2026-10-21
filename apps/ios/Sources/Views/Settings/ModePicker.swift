import SwiftUI

/// System, Light and Dark as the web's picker cards: each preview is the choice, its name centred
/// under it; the chosen one takes the accent ring 2pt outside its edge and its name full ink.
struct ModePicker: View {
    @Binding var selection: String

    var body: some View {
        HStack(alignment: .top, spacing: AceTheme.Spacing.lg) {
            ForEach(PhoneAppearance.modes, id: \.id) { mode in
                let chosen = selection == mode.id
                Button { selection = mode.id } label: {
                    VStack(spacing: AceTheme.Spacing.sm) {
                        AppPreview(scheme: mode.id)
                            .aspectRatio(0.78, contentMode: .fit)
                            .padding(AceTheme.Spacing.xs)
                            .overlay {
                                if chosen {
                                    RoundedRectangle(cornerRadius: AppPreview.radius + AceTheme.Spacing.xs)
                                        .strokeBorder(AceTheme.Colours.accent, lineWidth: AceTheme.Spacing.xxs)
                                }
                            }
                        Text(mode.label)
                            .aceFont(chosen ? AceTheme.Typography.label : AceTheme.Typography.caption, relativeTo: .subheadline)
                            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                            .lineLimit(1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mode.label)
                .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
                .accessibilityIdentifier("appearance.\(mode.id)")
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// The phone app in miniature, in the shared tokens of one scheme: a few task rows with their
/// status dots, the open one on the active fill, and the composer with Send. "system" splits it on
/// a diagonal, light on the left and dark on the right.
struct AppPreview: View {
    static let radius: CGFloat = 12
    let scheme: String

    var body: some View {
        ZStack {
            layer.environment(\.colorScheme, scheme == "dark" ? .dark : .light)
            if scheme == "system" {
                layer.environment(\.colorScheme, .dark).clipShape(Diagonal())
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Self.radius))
        .overlay(RoundedRectangle(cornerRadius: Self.radius).strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .accessibilityHidden(true)
    }

    private var layer: some View {
        GeometryReader { box in
            let unit = box.size.width / 20
            VStack(alignment: .leading, spacing: unit * 0.9) {
                row(AceTheme.Status.working, length: box.size.width * 0.5, open: true, unit: unit)
                row(AceTheme.Status.needsYou, length: box.size.width * 0.32, open: false, unit: unit)
                row(AceTheme.Status.done, length: box.size.width * 0.42, open: false, unit: unit)
                Spacer(minLength: AceTheme.Spacing.none)
                HStack(spacing: unit) {
                    Capsule().fill(AceTheme.Colours.subtleForeground.opacity(0.4)).frame(height: unit * 0.7)
                    Circle().fill(AceTheme.Colours.accent).frame(width: unit * 2.4, height: unit * 2.4)
                }
                .padding(.leading, unit * 1.4).padding(.trailing, unit * 0.5).padding(.vertical, unit * 0.5)
                .background(AceTheme.Colours.card, in: Capsule())
                .overlay(Capsule().strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
            }
            .padding(unit * 1.2)
            .frame(width: box.size.width, height: box.size.height, alignment: .topLeading)
            .background(AceTheme.Colours.background)
        }
    }
    private func row(_ dot: Color, length: CGFloat, open: Bool, unit: CGFloat) -> some View {
        HStack(spacing: unit * 0.8) {
            Circle().fill(dot).frame(width: unit * 0.9, height: unit * 0.9)
            Capsule().fill(open ? AceTheme.Colours.foreground.opacity(0.7) : AceTheme.Colours.subtleForeground.opacity(0.6))
                .frame(width: length, height: unit * 0.6)
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .padding(.horizontal, unit * 0.7).padding(.vertical, unit * 0.8)
        .background(open ? AceTheme.Colours.fill : Color.clear, in: RoundedRectangle(cornerRadius: unit * 0.8))
    }
}

/// The dark half of the System preview: right of a line from 62% along the top to 38% along the bottom.
private struct Diagonal: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX + rect.width * 0.62, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY))
            path.closeSubpath()
        }
    }
}
