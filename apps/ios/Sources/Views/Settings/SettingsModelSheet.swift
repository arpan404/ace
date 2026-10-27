import SwiftUI

/// The model sheet for a role or the utility model: the composer's picker (Favorites and one tab
/// per account, stars, "Find a model") over the machine's models (`settings.models`). The check
/// saves the picked model; X leaves the setting as it was.
struct SettingsModelSheet: View {
    let model: ClientModel
    let page: String
    let row: SettingsPageData.Row
    let save: (SettingsPageData.Pick) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var read = ComposeAgentsRead()
    @State private var current: NewThreadPickerRows.Chosen?
    @State private var picked: NewThreadPickerRows.Chosen?
    @State private var state: ModelPickerState = .loading
    @State private var query = ""
    @State private var shown: String?
    @State private var expanded: Set<String> = []

    private struct Reply: Decodable {
        let tabs: [ComposeTab]
        let providers: [ComposeAgent]
        let favorites: [String]
        let starProblem: String?
        let current: NewThreadPickerRows.Chosen?
    }
    private struct Starred: Decodable { let favorites: [String] }

    private var tabs: [ModelPickerTab] { NewThreadPickerRows.tabs(read) }
    private var chosen: NewThreadPickerRows.Chosen? { picked ?? current }
    private var tab: String {
        if let shown, tabs.contains(where: { $0.id == shown }) { return shown }
        let starred = read.tabs.first { $0.favorites }?.models.isEmpty == false
        return ModelPickerStart.tab(tabs, hasFavorites: starred, current: current.map { "\($0.provider):\($0.account)" })
    }
    private var hasMore: Bool {
        guard let entry = read.tabs.first(where: { $0.id == tab }) else { return false }
        return entry.models.count > entry.lead
    }

    var body: some View {
        let open = expanded.contains(tab)
        let listed = NewThreadPickerRows.rows(read, tab: tab, chosen: chosen, query: query, expanded: open)
        ModelPicker(
            query: $query, tabs: tabs, shown: Binding(get: { tab }, set: { shown = $0 }), state: state,
            rows: listed.rows, hidden: listed.hidden, expanded: open && hasMore && !ModelSearch.active(query),
            toggleMore: { withAnimation(.smooth) { if open { expanded.remove(tab) } else { expanded.insert(tab) } } },
            rowPrefix: "settingsModel", morePrefix: "settingsModel.\(tab)", starProblem: read.starProblem,
            retry: { Task { await load() } }, confirm: confirm, choose: choose, star: { star($0.key) }
        )
        .task { await load() }
        .sensoryFeedback(.selection, trigger: picked)
    }

    private func load() async {
        if state != .ready { state = .loading }
        do {
            let reply = try await model.service(["type": "settings.models", "page": page, "row": row.id], as: Reply.self)
            read = ComposeAgentsRead(state: "ready", agents: reply.providers, start: nil, tabs: reply.tabs,
                                     favorites: reply.favorites, starProblem: reply.starProblem)
            current = reply.current
            state = .ready
            if shown == nil, !tabs.isEmpty { shown = tab }
        } catch {
            state = .failed(title: "Couldn't load models", message: "Your machine didn't answer. Check the connection and try again.")
        }
    }
    private func choose(_ row: ModelPickerRow) {
        let refs = read.tabs.flatMap(\.models)
        guard let ref = refs.first(where: { $0.account + "\u{0}" + $0.key == row.id }),
              let (agent, found) = NewThreadPickerRows.resolve(read.agents, ref) else { return }
        picked = .init(provider: agent.provider, key: found.key, account: found.account)
    }
    private func confirm() {
        if let picked, picked != current { save(.init(key: picked.key, account: picked.account)) }
        dismiss()
    }
    private func star(_ key: String) {
        Task {
            do {
                let reply = try await model.service(["type": "settings.models.star", "key": key], as: Starred.self)
                read.favorites = reply.favorites
                read.starProblem = nil
                await load()
            } catch { read.starProblem = "Couldn't save this favourite. Reconnect and try again." }
        }
    }
}
