import SwiftUI

/// The grouped lists of Settings, Machines and the model sheet: the system list, one group per
/// place, rows on the quiet fill, a monochrome glyph at the icon size, the body role for labels
/// and a muted trailing value. Navigation chevrons, toggles and menus stay the system's own.
extension View {
    func insetGroupedList() -> some View {
        self.listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(AceDesign.Surface.background)
            .modifier(InsetRowDensity())
            .listSectionSpacing(AceDesign.Space.group)
    }
    /// Rows pass under the bottom search field behind a firm edge, so none reads through it.
    @ViewBuilder func searchBarEdge() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectStyle(.hard, for: .bottom) } else { self }
    }
    /// A row's fill inside an inset group.
    func insetRowBackground() -> some View { listRowBackground(AceDesign.Surface.fill).listRowSeparator(.hidden) }
}

/// On/off switches in the one accent (design language §3). Applied to a whole stack, so every
/// page it pushes gets it too.
struct SystemSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration).toggleStyle(.switch).tint(AceDesign.Ink.accent)
    }
}

extension ToggleStyle where Self == SystemSwitchStyle {
    static var systemSwitch: SystemSwitchStyle { SystemSwitchStyle() }
}

/// "Connections", "Options": a muted header on the meta role, in sentence case.
struct InsetHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title).font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.muted).textCase(nil)
    }
}

/// The grouped rows' measures, on the type roles: labels and values on body, headers on meta.
@MainActor enum InsetStyle {
    static let rowHeight = AceDesign.Size.rowLine
    static let label = AceTheme.Typography.label
    static let value = AceTheme.Typography.label
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
    @ScaledMetric(relativeTo: .subheadline) private var glyphSize = AceDesign.Size.icon

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
                Image(systemName: name).font(.system(size: glyphSize))
                    .foregroundStyle(AceDesign.Ink.primary)
                    .frame(width: glyphSize + AceDesign.Space.related).accessibilityHidden(true)
            case .ace(let name)?:
                AceIcon(name, size: AceDesign.Size.icon, relativeTo: .subheadline).foregroundStyle(AceDesign.Ink.primary)
                    .frame(width: glyphSize + AceDesign.Space.related)
            case nil:
                EmptyView()
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(title).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                if let subtitle {
                    Text(subtitle).font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
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
            Text(text).font(AceDesign.Typeface.body)
                .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
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
