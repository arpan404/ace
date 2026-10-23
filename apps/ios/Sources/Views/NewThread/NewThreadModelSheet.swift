import SwiftUI

/// New thread's model sheet: Favorites and one tab per account on a glass bar, the shown tab's
/// models below with stars, then effort, speed and access for the first turn. It opens on
/// Favorites when the person has starred any model, else on the account the draft runs on, with
/// its model checked wherever it shows. The tabs follow the web's rules (`newThreadTabs` in
/// `@ace/ui-core/mobile`): a CLI that isn't installed or signed in has no tab, and an account at
/// its limit says so above its models. Picks edit the draft as they're made; X puts the draft
/// back as it was.
struct NewThreadModelSheet: View {
    @Bindable var compose: ComposeModel
    let drafts: NewThreadDraftModel
    let reload: () -> Void
    /// Stars or unstars a model by its picker key, where the web keeps stars.
    let star: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var shown: String?
    @State private var snapshot: NewThreadChoice.Snapshot?
    private var draft: NewThreadDraft { drafts.draft }
    private var choice: NewThreadChoice { NewThreadChoice(compose: compose, draft: draft) }
    private var read: ComposeAgentsRead { compose.agentsRead }
    private var tabs: [ModelPickerTab] { NewThreadPickerRows.tabs(read) }
    private var chosen: NewThreadPickerRows.Chosen? {
        guard let agent = choice.agent, let model = choice.model else { return nil }
        return .init(provider: agent.provider, key: model.key, account: model.account)
    }
    /// The tab on screen: the one picked, else where the sheet opens.
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
            starProblem: read.starProblem, retry: reload, cancel: restore, confirm: { dismiss() },
            choose: pick, star: { star($0.key) }
        ) {
            // The options belong to the chosen model, whichever tab shows.
            NewThreadOptions(compose: compose, drafts: drafts, choice: choice)
        }
        .onAppear { if snapshot == nil { snapshot = .init(draft) } }
        // Where it opens is decided once the tabs arrive, so a new star never moves the sheet.
        .task(id: compose.agentsState) { if shown == nil, compose.agentsState == "ready", !tabs.isEmpty { shown = tab } }
    }
    private var hasMore: Bool {
        guard let entry = read.tabs.first(where: { $0.id == tab }) else { return false }
        return entry.models.count > entry.lead
    }
    private func providerOf(_ tab: String) -> String { tabs.first { $0.id == tab }?.provider ?? tab }
    private func pick(_ row: ModelPickerRow) {
        let refs = read.tabs.flatMap(\.models)
        guard let ref = refs.first(where: { $0.account + "\u{0}" + $0.key == row.id }),
              let (agent, model) = NewThreadPickerRows.resolve(read.agents, ref) else { return }
        drafts.edit { $0.provider = agent.provider; $0.model = model.key; $0.account = model.account; $0.effort = nil; $0.speed = nil }
    }
    private func restore() {
        guard let snapshot else { return }
        drafts.edit { snapshot.restore(&$0) }
    }
}
