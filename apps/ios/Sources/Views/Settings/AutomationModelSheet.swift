import SwiftUI

/// The automation editor's model sheet: the same picker New thread opens (`ModelPicker` with
/// `NewThreadPickerRows`, Favorites and one tab per account), checked on the automation's model.
/// A pick edits the editor's choice as it is made; X puts it back.
struct AutomationModelSheet: View {
    @Bindable var compose: ComposeModel
    @Binding var pick: AutomationPick?
    let reload: () -> Void
    let star: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var shown: String?
    @State private var before: AutomationPick??
    private var read: ComposeAgentsRead { compose.agentsRead }
    private var tabs: [ModelPickerTab] { NewThreadPickerRows.tabs(read) }
    private var chosen: NewThreadPickerRows.Chosen? {
        guard let pick, let account = pick.account ?? account(of: pick) else { return nil }
        return .init(provider: pick.provider, key: pick.key, account: account)
    }
    private var tab: String {
        if let shown, tabs.contains(where: { $0.id == shown }) { return shown }
        let starred = read.tabs.first { $0.favorites }?.models.isEmpty == false
        return ModelPickerStart.tab(tabs, hasFavorites: starred, current: chosen.map { "\($0.provider):\($0.account)" })
    }
    private var state: ModelPickerState {
        switch compose.agentsState {
        case "ready": .ready
        case "failed": .failed(title: "Couldn't read coding agents", message: "Your computer didn't answer.")
        default: .loading
        }
    }

    var body: some View {
        let open = expanded.contains(tab)
        let listed = NewThreadPickerRows.rows(read, tab: tab, chosen: chosen, query: query, expanded: open)
        ModelPicker(
            query: $query, tabs: tabs, shown: Binding(get: { tab }, set: { shown = $0 }), state: state,
            rows: listed.rows, hidden: listed.hidden, expanded: open && hasMore && !ModelSearch.active(query),
            toggleMore: { if open { expanded.remove(tab) } else { expanded.insert(tab) } },
            rowPrefix: "model.\(providerOf(tab))", morePrefix: "agent.\(providerOf(tab))",
            starProblem: read.starProblem, retry: reload, cancel: { if let before { pick = before } }, confirm: { dismiss() },
            choose: choose, star: { star($0.key) }
        )
        .onAppear { if before == nil { before = .some(pick) } }
        .task(id: compose.agentsState) { if shown == nil, compose.agentsState == "ready", !tabs.isEmpty { shown = tab } }
    }

    private var hasMore: Bool {
        guard let entry = read.tabs.first(where: { $0.id == tab }) else { return false }
        return entry.models.count > entry.lead
    }
    private func providerOf(_ tab: String) -> String { tabs.first { $0.id == tab }?.provider ?? tab }
    /// A stored pick without an account runs on the agent's first account serving its model.
    private func account(of pick: AutomationPick) -> String? {
        read.agents.first { $0.provider == pick.provider }?.models.first { $0.key == pick.key }?.account
    }
    private func choose(_ row: ModelPickerRow) {
        let refs = read.tabs.flatMap(\.models)
        guard let ref = refs.first(where: { $0.account + "\u{0}" + $0.key == row.id }),
              let (agent, model) = NewThreadPickerRows.resolve(read.agents, ref) else { return }
        // A new model starts at its own default effort.
        pick = AutomationPick(provider: agent.provider, key: model.key, account: model.account, effort: nil)
    }
}
