import SwiftUI

/// The open thread's model sheet: Effort and Speed at the top, then Favorites and one account at
/// a time of every coding agent set up on the machine, as New thread lists them (a CLI that isn't
/// installed or signed in has none; an account at its limit says so). It opens on Favorites when
/// any listed model is starred, else on the account the thread runs on, with its model checked.
///
/// A tap on a model checks it and the rows at the top switch at once to its levels, to set there
/// before closing with Done, a swipe or a tap outside. The bridge's rules decide when the move
/// happens: the same provider switches on the tap, and effort and speed taps apply on top of it;
/// another provider, or a move that needs a new thread, asks on the tap, then is held and sent as
/// the sheet closes, with the effort and speed picked for it. A row the thread can't move to says
/// why and can't be picked.
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
    /// A move the person confirmed, sent as the sheet closes with what was picked for it.
    @State private var held: NewThreadPickerRows.Chosen?
    /// Effort and speed picked for a model the thread isn't on yet, as the rows show them.
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

    var body: some View {
        let open = expanded.contains(tab)
        let listed = ThreadPickerRows.rows(list, tab: tab, chosen: chosen, query: query, expanded: open)
        ModelPicker(
            query: $query, tabs: tabs, shown: Binding(get: { tab }, set: { shown = $0 }), state: state,
            rows: listed.rows, hidden: listed.hidden, expanded: open && hasMore && !ModelSearch.active(query),
            toggleMore: { if open { expanded.remove(tab) } else { expanded.insert(tab) } },
            rowPrefix: "threadModel", morePrefix: "threadModel.\(tab)", starProblem: list.read.starProblem,
            retry: { model.requestModels() }, confirming: switching, confirm: { dismiss() }, closable: false,
            choose: pick, star: { model.favoriteModel($0.key) },
            tune: tune, pickEffort: pickEffort, pickSpeed: pickSpeed
        )
        .onAppear { model.requestModels() }
        // Done, a swipe or a tap outside: a confirmed move goes now, with its effort and speed.
        .onDisappear(perform: sendHeld)
        // Where it opens is decided once the list arrives, so a new star never moves the sheet.
        .task(id: screen.modelsState) { if shown == nil, screen.modelsState == "ready", !tabs.isEmpty { shown = tab } }
        .alert(asking?.ask.title ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
               presenting: asking) { asking in
            Button(asking.ask.action) { hold(asking.target) }
            Button("Cancel", role: .cancel) { picked = nil }
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
    /// The picked model's catalog row, for its levels while the thread isn't on it yet.
    private var pickedModel: ComposeAgent.Model? {
        guard let picked, picked != list.current else { return nil }
        return list.read.agents.first { $0.provider == picked.provider }?.models
            .first { $0.key == picked.key && $0.account == picked.account }
    }
    /// The picked model's levels until the thread runs on it, then the thread's own.
    private var tune: TuneChoices? {
        if let pickedModel { return TuneChoices.model(pickedModel, effort: heldEffort, speed: heldSpeed) }
        return screen.tune.map(TuneChoices.thread)
    }
    /// A held move keeps the pick until it is sent; otherwise it goes to the bridge at once, which
    /// keeps it for a switch still on its way. The model's own default goes back to it.
    private func pickEffort(_ level: TuneChoiceRow.Level) {
        let effort = level.isDefault ? nil : level.id
        if pickedModel != nil { heldEffort = effort }
        if held == nil { Task { _ = await model.setEffort(effort) } }
    }
    private func pickSpeed(_ level: TuneChoiceRow.Level) {
        if pickedModel != nil { heldSpeed = level.id }
        if held == nil { Task { _ = await model.setSpeed(level.id) } }
    }
    /// A tap on a model checks it and shows its levels. The same provider moves at once; a move
    /// that asks is confirmed now and held until the sheet closes.
    private func pick(_ row: ModelPickerRow) {
        let refs = list.read.tabs.flatMap(\.models)
        let current = list.current.map { $0.account + "\u{0}" + $0.key }
        guard !switching, row.id != (picked.map { $0.account + "\u{0}" + $0.key } ?? current) else { return }
        heldEffort = nil; heldSpeed = nil; held = nil
        if row.id == current { picked = nil; return }
        guard let ref = refs.first(where: { $0.account + "\u{0}" + $0.key == row.id }),
              let (agent, found) = NewThreadPickerRows.resolve(list.read.agents, ref) else { return }
        let target = NewThreadPickerRows.Chosen(provider: agent.provider, key: found.key, account: found.account)
        picked = target
        if let ask = list.ask(row.id) { asking = Asking(target: target, ask: ask); return }
        switching = true
        Task {
            let moved = await model.switchModel(key: target.key, account: target.account, confirmed: false)
            switching = false
            if !moved, asking == nil, picked == target { picked = nil }
        }
    }
    /// The person said yes: the move waits for the sheet to close, to go with its effort and speed.
    private func hold(_ target: NewThreadPickerRows.Chosen) {
        picked = target
        held = target
    }
    private func sendHeld() {
        guard let target = held else { return }
        held = nil
        let effort = heldEffort, speed = heldSpeed
        Task { _ = await model.switchModel(key: target.key, account: target.account, confirmed: true, effort: effort, speed: speed) }
    }
}
