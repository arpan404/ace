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
    /// A row's fill inside an inset group.
    func insetRowBackground() -> some View { listRowBackground(AceTheme.Colours.fill).listRowSeparator(.hidden) }
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
    let systemImage: String?
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: AceTheme.Spacing.md + AceTheme.Spacing.xxs) {
            if let systemImage {
                Image(systemName: systemImage).font(.system(size: 19, weight: .regular))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: 24).accessibilityHidden(true)
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
