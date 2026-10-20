import SwiftUI

/// Every destination keeps the selected machine's SDK connection, including on multi-machine inboxes.
struct MachineFeaturesView: View {
    let inbox: MachineInbox
    let machineId: String
    var body: some View {
        List {
            if let client = inbox.client(machineId) {
                NavigationLink("Providers") { ProviderSettingsView(model: client) }
                NavigationLink("Usage") { UsageView(model: client) }
                NavigationLink("Automations") { AutomationsView(model: client) }
                NavigationLink("Prompts") { PromptsView(model: client) }
                ForEach(RemoteSettingsCategory.all) { category in
                    NavigationLink(category.title) { RemoteSettingsView(model: client, category: category) }
                }
            }
        }
        .navigationTitle(inbox.name(machineId)).navigationBarTitleDisplayMode(.inline)
    }
}
