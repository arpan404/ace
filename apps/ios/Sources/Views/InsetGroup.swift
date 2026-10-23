import SwiftUI

/// The inset-grouped lists of Settings, Machines and the model sheet: the system list, with
/// 56pt rows on a quiet fill, a 21pt monochrome symbol, a 16.5pt label and a muted trailing
/// value. Navigation chevrons, toggles and menus stay the system's own.
extension View {
    func insetGroupedList() -> some View {
        self.listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .environment(\.defaultMinListRowHeight, InsetStyle.rowHeight)
            .listSectionSpacing(AceTheme.Spacing.sm)
    }
    /// Rows pass under the bottom search field behind a firm edge, so none reads through it.
    @ViewBuilder func searchBarEdge() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectStyle(.hard, for: .bottom) } else { self }
    }
    /// A row's fill inside an inset group.
    func insetRowBackground() -> some View { listRowBackground(AceTheme.Colours.fill).listRowSeparator(.hidden) }
}

/// On/off switches in the system's own green: the ink accent the sheets tint with would hide an
/// on switch's knob. Applied to a whole stack, so every page it pushes gets it too.
struct SystemSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration).toggleStyle(.switch).tint(Color(uiColor: .systemGreen))
    }
}

extension ToggleStyle where Self == SystemSwitchStyle {
    static var systemSwitch: SystemSwitchStyle { SystemSwitchStyle() }
}

/// "Connections", "Options": a 14pt medium muted header in sentence case.
struct InsetHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title).aceFont(InsetStyle.header, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground).textCase(nil)
    }
}

/// The inset rows' measures, from the approved mockup.
@MainActor enum InsetStyle {
    static let rowHeight: CGFloat = 56
    static let label = AceTheme.TypeStyle(size: 16.5, lineHeight: 22, weight: 400, tracking: -0.1)
    static let value = AceTheme.TypeStyle(size: 15.5, lineHeight: 20, weight: 400, tracking: 0)
    static let header = AceTheme.TypeStyle(size: 14, lineHeight: 19, weight: 500, tracking: 0)
}

/// One row: symbol, label (with an optional muted line under it) and a trailing view.
struct InsetRow<Trailing: View>: View {
    /// An SF Symbol, or one of ace's own icons on screens drawn with them.
    enum Glyph { case symbol(String), ace(AceIcon.Name) }
    let glyph: Glyph?
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    init(systemImage: String?, title: String, subtitle: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.init(glyph: systemImage.map(Glyph.symbol), title: title, subtitle: subtitle, trailing: trailing)
    }
    init(icon: AceIcon.Name?, title: String, subtitle: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.init(glyph: icon.map(Glyph.ace), title: title, subtitle: subtitle, trailing: trailing)
    }
    private init(glyph: Glyph?, title: String, subtitle: String?, trailing: @escaping () -> Trailing) {
        self.glyph = glyph
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.md + AceTheme.Spacing.xxs) {
            switch glyph {
            case .symbol(let name)?:
                Image(systemName: name).font(.system(size: 19, weight: .regular))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: 24).accessibilityHidden(true)
            case .ace(let name)?:
                AceIcon(name, size: 19).foregroundStyle(AceTheme.Colours.foreground).frame(width: 24)
            case nil:
                EmptyView()
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(title).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if let subtitle {
                    Text(subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            trailing()
        }
        .contentShape(Rectangle())
    }
}

extension InsetRow where Trailing == InsetValue {
    /// A row with a muted value on the right ("2", "On", "System").
    init(_ title: String, systemImage: String?, value: String? = nil, subtitle: String? = nil) {
        self.init(systemImage: systemImage, title: title, subtitle: subtitle) { InsetValue(text: value) }
    }
}

/// The muted trailing value of an inset row.
struct InsetValue: View {
    let text: String?
    var body: some View {
        if let text {
            Text(text).aceFont(InsetStyle.value, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
        }
    }
}
