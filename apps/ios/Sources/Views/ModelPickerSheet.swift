import SwiftUI

/// The open thread's model sheet, models only: Favorites and one tab per account of every coding
/// agent set up on the machine, as New thread lists them (a CLI that isn't installed or signed in
/// has no tab; an account at its limit says so). It opens on Favorites when any listed model is
/// starred, else on the account the thread runs on, with its model checked. Picking marks a model;
/// the check moves the thread to it by the bridge's rules: the same provider switches at once,
/// another provider asks first, and a move that needs a new thread asks, then waits for the next
/// message. A row the thread can't move to says why and can't be picked. Effort and Speed sit at
/// the top for the model it would run on: on the model in use a tap applies at once, as the
/// bridge takes it for the next message; on a model picked in the list it is held and goes with
/// the move.
struct ModelPickerSheet: View {
    let model: ClientModel
    @Bindable var screen: ThreadScreenModel
    @Environment(\.dismiss) private var dismiss
    @State private var picked: NewThreadPickerRows.Chosen?
    @State private var switching = false
    @State private var query = ""
    @State private var shown: String?
    @State private var expanded: Set<String> = []
    @State private var asking: Asking?
    /// Effort and speed picked for a model other than the one in use, sent with the move.
    @State private var heldEffort: String?
    @State private var heldSpeed: String?

    /// A move waiting on the person's answer, in the bridge's words.
    private struct Asking { let target: NewThreadPickerRows.Chosen; let ask: ThreadModels.Ask }

    private var list: ThreadModels { screen.modelList }
    private var tabs: [ModelPickerTab] { NewThreadPickerRows.tabs(list.read) }
    private var chosen: NewThreadPickerRows.Chosen? { picked ?? list.current }
    /// The tab on screen: the one picked, else where the sheet opens.
    private var tab: String {
        if let shown, tabs.contains(where: { $0.id == shown }) { return shown }
        let starred = list.read.tabs.first { $0.favorites }?.models.isEmpty == false
        return ModelPickerStart.tab(tabs, hasFavorites: starred, current: list.current.map { "\($0.provider):\($0.account)" })
    }
    private var state: ModelPickerState {
        switch screen.modelsState {
        case "ready": .ready
        case "failed": .failed(title: "Couldn't load models", message: "Your machine didn't answer. Check the connection and try again.")
        default: .loading
        }
    }

    /// The picked model's catalog row, for its levels.
    private var pickedModel: ComposeAgent.Model? {
        guard let picked else { return nil }
        return list.read.agents.first { $0.provider == picked.provider }?.models
            .first { $0.key == picked.key && $0.account == picked.account }
    }
    private var onCurrent: Bool { picked == nil || picked == list.current }
    private var tune: TuneChoices? {
        TuneChoices.forThread(tune: screen.tune, current: list.current, target: chosen, model: pickedModel,
                              effort: heldEffort, speed: heldSpeed)
    }

    var body: some View {
        let open = expanded.contains(tab)
        let listed = ThreadPickerRows.rows(list, tab: tab, chosen: chosen, query: query, expanded: open)
        ModelPicker(
            query: $query, tabs: tabs, shown: Binding(get: { tab }, set: { shown = $0 }), state: state,
            rows: listed.rows, hidden: listed.hidden, expanded: open && hasMore && !ModelSearch.active(query),
            toggleMore: { if open { expanded.remove(tab) } else { expanded.insert(tab) } },
            rowPrefix: "threadModel", morePrefix: "threadModel.\(tab)", starProblem: list.read.starProblem,
            retry: { model.requestModels() }, confirming: switching, confirm: confirm,
            choose: pick, star: { model.favoriteModel($0.key) },
            tune: tune, pickEffort: pickEffort, pickSpeed: pickSpeed
        )
        .onAppear { model.requestModels() }
        // Where it opens is decided once the list arrives, so a new star never moves the sheet.
        .task(id: screen.modelsState) { if shown == nil, screen.modelsState == "ready", !tabs.isEmpty { shown = tab } }
        .alert(asking?.ask.title ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
               presenting: asking) { asking in
            Button(asking.ask.action) { move(to: asking.target, confirmed: true) }
            Button("Cancel", role: .cancel) {}
        } message: { asking in
            Text(asking.ask.body)
        }
        // The bridge asks when the rows were older than the thread: the question it sends wins.
        .onChange(of: screen.switchAsk) { _, sent in
            guard let sent else { return }
            screen.switchAsk = nil
            let target = NewThreadPickerRows.Chosen(provider: provider(of: sent), key: sent.key, account: sent.account)
            asking = Asking(target: target, ask: sent.ask)
        }
    }
    private var hasMore: Bool {
        guard let entry = list.read.tabs.first(where: { $0.id == tab }) else { return false }
        return entry.models.count > entry.lead
    }
    private func provider(of sent: SwitchAsk) -> String {
        let ref = ComposeTab.Ref(key: sent.key, account: sent.account)
        return NewThreadPickerRows.resolve(list.read.agents, ref)?.0.provider ?? ""
    }
    private func pickEffort(_ level: TuneChoiceRow.Level) {
        // The model's own default goes back to it rather than naming it.
        if onCurrent { Task { _ = await model.setEffort(level.isDefault ? nil : level.id) } }
        else { heldEffort = level.id }
    }
    private func pickSpeed(_ level: TuneChoiceRow.Level) {
        if onCurrent { Task { _ = await model.setSpeed(level.id) } }
        else { heldSpeed = level.id }
    }
    private func pick(_ row: ModelPickerRow) {
        heldEffort = nil; heldSpeed = nil
        if let current = list.current, row.id == current.account + "\u{0}" + current.key { picked = current; return }
        let refs = list.read.tabs.flatMap(\.models)
        guard let ref = refs.first(where: { $0.account + "\u{0}" + $0.key == row.id }),
              let (agent, found) = NewThreadPickerRows.resolve(list.read.agents, ref) else { return }
        picked = .init(provider: agent.provider, key: found.key, account: found.account)
    }
    private func confirm() {
        guard let picked, picked != list.current else { dismiss(); return }
        if let ask = list.ask(picked.account + "\u{0}" + picked.key) { asking = Asking(target: picked, ask: ask); return }
        move(to: picked, confirmed: false)
    }
    private func move(to target: NewThreadPickerRows.Chosen, confirmed: Bool) {
        switching = true
        Task {
            let held = target == picked
            let moved = await model.switchModel(key: target.key, account: target.account, confirmed: confirmed,
                                                effort: held ? heldEffort : nil, speed: held ? heldSpeed : nil)
            switching = false
            if moved { dismiss() }
        }
    }
}
