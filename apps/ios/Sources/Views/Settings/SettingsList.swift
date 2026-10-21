import SwiftUI

/// Settings pages, cardless like the web's: a section is a heading over hairline-separated rows
/// on the opaque page, with no filled card around it. The list stays the system's, so swipe
/// actions, pushes, menus and Dynamic Type behave natively.
@MainActor enum SettingsStyle {
    /// The page's left and right edge for headings, rows and their hairlines.
    static let margin = AceTheme.Spacing.xl
    static let rowHeight: CGFloat = 48
    static let rowInset = AceTheme.Spacing.sm + AceTheme.Spacing.xxs
    static let groupGap = AceTheme.Spacing.xxxl
    static let heading = AceTheme.TypeStyle(size: 16, lineHeight: 21, weight: 500, tracking: -0.1)
    static let label = AceTheme.TypeStyle(size: 16, lineHeight: 21, weight: 400, tracking: -0.1)
    static let value = AceTheme.TypeStyle(size: 15, lineHeight: 20, weight: 400, tracking: 0)
}

extension View {
    /// A settings page: the system list on the opaque page, without cards or system separators.
    func settingsList() -> some View {
        self.listStyle(.grouped)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .environment(\.defaultMinListRowHeight, SettingsStyle.rowHeight)
            .listSectionSpacing(SettingsStyle.groupGap)
            .toggleStyle(AceSwitchStyle())
    }
    /// A row of a settings section: no fill, a hairline above it at the page's edges.
    func settingsRow() -> some View {
        self.listRowBackground(SettingsRule())
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: SettingsStyle.rowInset, leading: SettingsStyle.margin,
                                      bottom: SettingsStyle.rowInset, trailing: SettingsStyle.margin))
    }
}

/// The hairline over each row: the first one rules the heading off, the rest divide the rows.
private struct SettingsRule: View {
    @Environment(\.displayScale) private var scale
    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Rectangle().fill(AceTheme.Colours.separator).frame(height: 1 / scale)
                .padding(.horizontal, SettingsStyle.margin)
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .background(AceTheme.Colours.background)
    }
}

/// "Connections": the section's heading at full ink, with an optional note under it that explains
/// the whole group once.
struct SettingsHeader: View {
    let title: String
    var note: String? = nil
    init(_ title: String, note: String? = nil) { self.title = title; self.note = note }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(title).aceFont(SettingsStyle.heading, relativeTo: .headline)
                .foregroundStyle(AceTheme.Colours.foreground)
                .accessibilityAddTraits(.isHeader)
            if let note {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .textCase(nil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: SettingsStyle.margin,
                                  bottom: AceTheme.Spacing.sm, trailing: SettingsStyle.margin))
    }
}

/// One setting: its label, an optional one-line description under it, and the control or value
/// at the right edge.
struct SettingsRow<Trailing: View>: View {
    let title: String
    var description: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(title).aceFont(SettingsStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if let description {
                    Text(description).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            trailing()
        }
        .contentShape(Rectangle())
    }
}

extension SettingsRow where Trailing == SettingsValue {
    /// A row with a muted value at the right ("2", "On", "System").
    init(_ title: String, value: String? = nil, description: String? = nil) {
        self.init(title: title, description: description) { SettingsValue(text: value) }
    }
}

/// The muted value at a row's right edge.
struct SettingsValue: View {
    let text: String?
    var body: some View {
        if let text {
            Text(text).aceFont(SettingsStyle.value, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
        }
    }
}

/// A page link in Settings' own list: a quiet outlined glyph, the page's name and its value.
/// The glyph stays at the subtle tier, as on the web's settings list.
struct SettingsLinkLabel: View {
    let title: String
    let symbol: String
    var value: String? = nil
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Image(systemName: symbol).font(.system(size: 17, weight: .regular))
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .frame(width: AceTheme.Spacing.xxl).accessibilityHidden(true)
            Text(title).aceFont(SettingsStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
            Spacer(minLength: AceTheme.Spacing.sm)
            SettingsValue(text: value)
        }
        .contentShape(Rectangle())
    }
}

/// The web's switch: the accent fills it when on, with its knob in the accent's own ink, so it
/// reads in both schemes (the system knob is always white, which vanishes on a light accent).
struct AceSwitchStyle: ToggleStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                configuration.label
                Spacer(minLength: AceTheme.Spacing.sm)
                track(configuration.isOn)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : AceTheme.Opacity.disabled(scheme))
        .sensoryFeedback(.selection, trigger: configuration.isOn)
        .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
    }
    private func track(_ on: Bool) -> some View {
        Capsule()
            .fill(on ? AceTheme.Colours.accent : AceTheme.Colours.fill)
            .overlay(Capsule().strokeBorder(on ? Color.clear : AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
            .frame(width: 46, height: 28)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(on ? AceTheme.Colours.onAccent : AceTheme.Colours.mutedForeground)
                    .frame(width: 22, height: 22)
                    .padding(AceTheme.Spacing.xs - 1)
            }
            .animation(reduceMotion ? nil : AceTheme.Motion.spring, value: on)
    }
}
