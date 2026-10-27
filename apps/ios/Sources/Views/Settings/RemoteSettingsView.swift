import SwiftUI

/// A page of one machine's own settings, listed on its detail page. Each page's rows, titles,
/// choices and checks come from the bridge (`bridge/settings-page-rows.ts`) and are drawn by
/// `SettingsPageView`, so every machine setting on the phone has the same scope control.
struct RemoteSettingsCategory: Identifiable {
    let title: String
    var symbol = "slider.horizontal.3"
    /// The bridge's page id (`settingsPages`).
    let page: String
    var id: String { page }

    /// Default provider, access, recovery and limits, roles, the thread list, generation and
    /// automations, as the web's Agents page groups them.
    static let agents = RemoteSettingsCategory(title: "Agents", symbol: "person.2", page: "agents")
    static let computer = RemoteSettingsCategory(title: "App access and devices", page: "computer")
    static let browser = RemoteSettingsCategory(title: "Browser and computer", symbol: "safari", page: "browser")
    /// Moving work to the machines this one links to (ADR 0101); shown only while it links to one.
    static let fleet = RemoteSettingsCategory(title: "Fleet", symbol: "point.3.connected.trianglepath.dotted", page: "fleet")
    static let all: [RemoteSettingsCategory] = [
        agents,
        .init(title: "Remote access", symbol: "antenna.radiowaves.left.and.right", page: "remote"),
        .init(title: "Storage", symbol: "internaldrive", page: "storage"),
        browser,
    ]
}

struct RemoteSettingsView: View {
    let model: ClientModel
    let category: RemoteSettingsCategory
    var body: some View {
        SettingsPageView(model: model, page: category.page, title: category.title)
    }
}
