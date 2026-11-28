import SwiftUI

/// A page of one machine's own settings, listed on its detail page. Each page's rows, titles,
/// choices and checks come from the bridge (`bridge/settings-page-rows.ts`) and are drawn by
/// `SettingsPageView`, so every machine setting on the phone has the same scope control.
struct RemoteSettingsCategory: Identifiable {
    let title: String
    var icon = AceIcon.Name.slidersHorizontal
    /// The bridge's page id (`settingsPages`).
    let page: String
    var id: String { page }

    /// Default provider, access, recovery and limits, roles, the thread list, generation and
    /// automations, as the web's Agents page groups them.
    static let agents = RemoteSettingsCategory(title: "Agents", icon: .users, page: "agents")
    static let computer = RemoteSettingsCategory(title: "App access", page: "computer")
    /// Simulators and emulators on or off, the emulator window, and the tools they need.
    static let simulators = RemoteSettingsCategory(title: "Simulators", icon: .deviceMobile, page: "simulators")
    static let browser = RemoteSettingsCategory(title: "Browser", icon: .compass, page: "browser")
    /// One switch per way a signed automation webhook can reach the machine (ADR 0173).
    static let automationWebhooks = RemoteSettingsCategory(title: "Automation webhooks", icon: .plugsConnected, page: "automationWebhooks")
    /// Moving work to the machines this one links to (ADR 0101); shown only while it links to one.
    static let fleet = RemoteSettingsCategory(title: "Fleet", icon: .graph, page: "fleet")
    /// Features still being tried out on this machine, last, as web lists Settings › Beta.
    static let beta = RemoteSettingsCategory(title: "Beta", icon: .flask, page: "beta")
    static let all: [RemoteSettingsCategory] = [
        agents,
        .init(title: "Remote access", icon: .globe, page: "remote"),
        automationWebhooks,
        browser,
        simulators,
        beta,
    ]
}

struct RemoteSettingsView: View {
    let model: ClientModel
    let category: RemoteSettingsCategory
    var body: some View {
        if category.page == RemoteSettingsCategory.simulators.page {
            SimulatorsSettingsView(model: model)
        } else if category.page == RemoteSettingsCategory.browser.page {
            SettingsPageView(model: model, page: category.page, title: category.title) {
                BrowserPhoneSection(model: model)
            }
        } else {
            SettingsPageView(model: model, page: category.page, title: category.title)
        }
    }
}

/// Settings › Browser's own choices on this iPhone, under the machine's: picture-in-picture.
private struct BrowserPhoneSection: View {
    let model: ClientModel
    @AppStorage(BrowserPipRule.settingKey) private var pip = true
    var body: some View {
        Section {
            InsetRow(icon: nil, title: "Picture in picture") {
                Toggle("Picture in picture", isOn: $pip).labelsHidden()
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.browser.pip")
        } header: { InsetHeader("This iPhone") } footer: {
            Text("When you leave the Browser while an agent browses or the page plays sound, the page keeps showing in a floating window.")
        }
        .insetRowBackground()
        .onChange(of: pip) { model.browser.updatePip() }
    }
}
