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
            .barEdge()
    }
    /// Rows scroll under the navigation bar behind a firm edge, so none reads through the title
    /// (iOS 26's hard scroll-edge effect; before it the system bar's own material).
    @ViewBuilder func barEdge() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectStyle(.hard, for: .top) } else { self }
    }
    /// Rows pass under the bottom search field behind a firm edge, so none reads through it.
    @ViewBuilder func searchBarEdge() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectStyle(.hard, for: .bottom) } else { self }
    }
    /// A row's fill inside an inset group: the grouped surface, no dividers.
    func insetRowBackground() -> some View { listRowBackground(AceDesign.Surface.group).listRowSeparator(.hidden) }
}

/// On/off switches in the one accent (design language §3). Applied to a whole stack, so every
/// page it pushes gets it too.
struct SystemSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration).toggleStyle(.switch).tint(AceDesign.Ink.action)
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
        Text(title).aceFont(AceDesign.TextRole.meta)
            .foregroundStyle(AceDesign.Ink.subtle).textCase(nil)
    }
}

/// The grouped rows' measures, on the type roles: labels and values on body, headers on meta.
@MainActor enum InsetStyle {
    static let rowHeight = AceDesign.Size.rowLine
    static let label = AceDesign.TextRole.rowTitle
    static let value = AceDesign.TextRole.rowTitle
    static let header = AceDesign.TextRole.meta
}

/// One row: symbol, label (with an optional muted line under it) and a trailing view.
struct InsetRow<Trailing: View>: View {
    /// An SF Symbol, or one of ace's own icons on screens drawn with them.
    enum Glyph { case symbol(String), ace(AceIcon.Name) }
    let glyph: Glyph?
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing
    @ScaledMetric(relativeTo: .subheadline) private var glyphSize = AceDesign.Size.groupGlyph

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

    @Environment(\.dynamicTypeSize) private var typeSize

    /// At accessibility sizes the row stacks: the decorative glyph steps aside so the title has
    /// the row's whole width and wraps only at word breaks, and the trailing view goes under it,
    /// so neither a value nor a glyph squeezes a word apart or overlaps it.
    var body: some View {
        if stacked {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                words
                trailing()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        } else {
            HStack(spacing: AceDesign.Space.groupGlyphGap) {
                glyphView
                words
                Spacer(minLength: AceDesign.Space.related)
                trailing()
            }
            .contentShape(Rectangle())
        }
    }

    private var stacked: Bool { typeSize.isAccessibilitySize }

    @ViewBuilder private var glyphView: some View {
        switch glyph {
        case .symbol(let name)?:
            Image(systemName: name).font(.system(size: glyphSize - AceDesign.Space.tight, weight: AceDesign.Typeface.regular))
                .foregroundStyle(AceDesign.Ink.muted)
                .frame(width: glyphSize).accessibilityHidden(true)
        case .ace(let name)?:
            AceIcon(name, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline).foregroundStyle(AceDesign.Ink.muted)
                .frame(width: glyphSize).accessibilityHidden(true)
        case nil:
            EmptyView()
        }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                Text(subtitle).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(stacked ? nil : 1)
            }
        }
        .layoutPriority(1)
    }
}

extension InsetRow where Trailing == InsetValue {
    /// A row with a muted value on the right ("2", "On", "System").
    init(_ title: String, systemImage: String?, value: String? = nil, subtitle: String? = nil) {
        self.init(systemImage: systemImage, title: title, subtitle: subtitle) { InsetValue(text: value) }
    }
    /// The same with one of ace's own glyphs.
    init(_ title: String, icon: AceIcon.Name, value: String? = nil, subtitle: String? = nil) {
        self.init(icon: icon, title: title, subtitle: subtitle) { InsetValue(text: value) }
    }
}

/// The one row that adds something to the list above it ("Add account", "New automation"): a
/// plus in the glyph column and the words, both in the action colour, at the row's height. A
/// label, so it goes in a Button or a NavigationLink.
struct AddRow: View {
    let title: String
    init(_ title: String) { self.title = title }
    @ScaledMetric(relativeTo: .subheadline) private var glyphSize = AceDesign.Size.groupGlyph
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.groupGlyphGap) {
            Image(systemName: "plus").font(.system(size: glyphSize - AceDesign.Space.tight, weight: AceDesign.Typeface.strong))
                .frame(width: glyphSize).accessibilityHidden(true)
            Text(title).aceFont(AceDesign.TextRole.rowTitle).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: AceDesign.Space.related)
        }
        .foregroundStyle(AceDesign.Ink.action)
        .opacity(enabled ? 1 : AceTheme.Opacity.disabled(scheme))
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowLine, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// The muted trailing value of an inset row.
struct InsetValue: View {
    let text: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        if let text {
            Text(text).aceFont(AceDesign.TextRole.action)
                .foregroundStyle(AceDesign.Ink.subtle).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
        }
    }
}

/// A settings row's least height at the chosen density (Settings › Appearance).
private struct InsetRowDensity: ViewModifier {
    @Environment(\.aceDensityId) private var density
    func body(content: Content) -> some View {
        content.environment(\.defaultMinListRowHeight, min(AceTheme.density(density).settingsRowHeight, AceDesign.Size.settingsRow))
    }
}

extension EnvironmentValues {
    /// Pushes a page on Settings' and More's own stack, for `GroupLink`.
    @Entry var settingsPush: (SettingsRoute) -> Void = { _ in }
}

/// A grouped row that opens a page: the row, then the approved mockup's small faint caret in
/// place of the system's chevron. It pushes on the sheet's own stack.
struct GroupLink<Label: View>: View {
    let route: SettingsRoute
    @ViewBuilder let label: () -> Label
    @Environment(\.settingsPush) private var push
    init(_ route: SettingsRoute, @ViewBuilder label: @escaping () -> Label) {
        self.route = route
        self.label = label
    }
    var body: some View {
        Button { push(route) } label: {
            HStack(spacing: AceDesign.Space.related) {
                label()
                AceIcon(.caretRight, size: AceDesign.Size.chevron, weight: .bold, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.faintForeground)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(GroupRowStyle())
        .accessibilityAddTraits(.isButton)
    }
}

/// A grouped row pressed: a moment's dimming, as the system's rows answer a tap.
private struct GroupRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? AceDesign.Ink.pressed : 1)
    }
}
