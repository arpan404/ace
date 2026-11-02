import SwiftUI

/// The inset-grouped lists of Settings, Machines and the model sheet: the system list, with
/// 56pt rows on a quiet fill, a 21pt monochrome symbol, a 16.5pt label and a muted trailing
/// value. Navigation chevrons, toggles and menus stay the system's own.
extension View {
    func insetGroupedList() -> some View {
        self.listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .modifier(InsetRowDensity())
            .listSectionSpacing(AceDesign.Space.related)
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

/// The inset rows' measures: the title role for a row's name, the body role for its value and
/// meta for a section's header (design language §3).
@MainActor enum InsetStyle {
    /// A glyph row with room for a subtitle under its name: taller than a one-line row.
    static let rowHeight: CGFloat = 56
    static let label = AceTheme.Typography.body
    static let value = AceTheme.Typography.rowTitle
    static let header = AceTheme.Typography.meta
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
        HStack(spacing: AceDesign.Space.row) {
            switch glyph {
            case .symbol(let name)?:
                Image(systemName: name).font(.system(size: AceDesign.Size.barIcon))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: AceDesign.Size.glyphBox).accessibilityHidden(true)
            case .ace(let name)?:
                AceIcon(name, size: AceDesign.Size.barIcon).foregroundStyle(AceTheme.Colours.foreground).frame(width: AceDesign.Size.glyphBox)
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
            Spacer(minLength: AceDesign.Space.related)
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

/// A settings row's least height at the chosen density (Settings › Appearance).
private struct InsetRowDensity: ViewModifier {
    @Environment(\.aceDensityId) private var density
    func body(content: Content) -> some View {
        content.environment(\.defaultMinListRowHeight, AceTheme.density(density).settingsRowHeight)
    }
}
