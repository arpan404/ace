import SwiftUI

/// Settings with a query: the matching pages and settings on this phone, then each machine's
/// under its name, each row saying where it sits. A row opens its page inside Settings; a machine
/// setting opens its machine's page with that row in view.
struct SettingsSearchResults: View {
    let inbox: MachineInbox
    let query: String
    let notifications: Bool
    let lock: Bool
    let index: MachineSettingsIndex

    var body: some View {
        let phone = SettingsSearch.matches(SettingsSearch.phoneItems(notifications: notifications, lock: lock), query: query)
        let machines = inbox.sessions.compactMap { session -> (String, [SettingsResult])? in
            let items = SettingsSearch.machineSearchItems(index.entries[session.hostId], machine: session.hostId,
                                                          fleet: session.client.transfers.linked, spade: session.client.spade.shown == true)
            let found = SettingsSearch.matches(items, query: query)
            return found.isEmpty ? nil : (session.hostId, found)
        }
        List {
            if !phone.isEmpty {
                Section { rows(phone) } header: { InsetHeader("On this phone") }
                    .insetRowBackground()
            }
            ForEach(machines, id: \.0) { machine in
                Section { rows(machine.1) } header: { InsetHeader(inbox.name(machine.0)) }
                    .insetRowBackground()
            }
            if phone.isEmpty && machines.isEmpty {
                EmptyState.search(query)
                    .listRowBackground(Color.clear)
                    .padding(.vertical, AceDesign.Space.group)
            }
        }
        .insetGroupedList()
        .task(id: inbox.sessions.map { "\($0.hostId):\($0.client.connection)" }) { await index.read(inbox) }
    }

    private func rows(_ found: [SettingsResult]) -> some View {
        ForEach(found) { result in
            Group {
                if case .web(let url) = result.target {
                    Link(destination: url) { InsetRow(result.title, icon: nil, subtitle: result.place) }
                } else {
                    GroupLink(route(result.target)) { InsetRow(result.title, icon: nil, subtitle: result.place) }
                }
            }
            .accessibilityIdentifier("settings.search.\(result.id)")
        }
    }

    private func route(_ target: SettingsResult.Target) -> SettingsRoute {
        switch target {
        case .phone(let route): route
        case .web: .licences
        case let .machine(machine, page, title, row): .machineSetting(machine: machine, page: page, title: title, row: row)
        }
    }
}
