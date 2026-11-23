import SwiftUI

/// The Permissions (ADR 0171, amendment 7): one switch per kind of reach, its title and one plain
/// line, in web's order. The same rows show the machine's defaults in Settings › Spade › Security
/// and, over those, a bot's own in its profile's Permissions tab: there a switch the bot sets
/// itself offers Use default (`save(key, nil)`). Rows only, for the caller's section; what sits
/// under a switch (the apps bots never use, under Computer use) comes from `under`.
struct SpadePermissionRows<Under: View>: View {
    let permissions: [SpadeSettings.Permission]
    /// A change is out: the switches wait for it.
    var busy = false
    /// On a bot: a switch it sets itself offers Use default.
    var bot = false
    let save: (_ key: String, _ on: Bool?) -> Void
    @ViewBuilder var under: (_ key: String) -> Under

    var body: some View {
        ForEach(permissions) { permission in
            row(permission)
            under(permission.key)
        }
    }

    private func row(_ permission: SpadeSettings.Permission) -> some View {
        Toggle(isOn: Binding(get: { permission.on }, set: { save(permission.key, $0) })) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(permission.title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                Text(permission.line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                if bot, permission.own {
                    Button("Use default") { save(permission.key, nil) }
                        .buttonStyle(.borderless)
                        .aceFont(AceDesign.TextRole.action)
                        .padding(.top, AceDesign.Space.tight)
                        .accessibilityIdentifier("spade.permission.default.\(permission.key)")
                }
            }
        }
        .disabled(busy)
        .accessibilityIdentifier("spade.permission.\(permission.key)")
    }
}

extension SpadePermissionRows where Under == EmptyView {
    init(permissions: [SpadeSettings.Permission], busy: Bool = false, bot: Bool = false,
         save: @escaping (_ key: String, _ on: Bool?) -> Void) {
        self.init(permissions: permissions, busy: busy, bot: bot, save: save) { _ in EmptyView() }
    }
}
