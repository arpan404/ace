import SwiftUI

/// Everything installed from the market on this machine (spec items 16 to 19): updates first,
/// each row's type, version and machine, a withdrawn entry off with its reason. Swipe to remove
/// (asked first) or turn back on; Update opens the review in update mode; pull to refresh has the
/// machine read its sources again. Offline, it shows what this phone kept and changes nothing.
struct MarketInstalledView: View {
    let model: ClientModel
    let machineName: String
    @State private var page: MarketInstalledPage?
    @State private var problem: MarketRefusal?
    @State private var route: MarketRoute?
    @State private var updating: MarketInstalledItem?
    @State private var removing: MarketInstalledItem?
    /// The row whose change is under way.
    @State private var working: String?
    @State private var removed = 0
    @State private var turnedOn = 0
    @State private var refreshed = 0

    init(model: ClientModel, machineName: String) {
        self.model = model
        self.machineName = machineName
        _page = State(initialValue: model.keptMarket(Self.read, as: MarketInstalledPage.self))
    }

    private static var read: [String: Any] { ["op": "installed"] }
    private var offline: Bool { page?.offline ?? false }

    var body: some View {
        List {
            if let problem {
                Section {
                    ProblemRow(problem.message, id: "market.installed.problem", retry: problem.way == .retry ? reread : nil)
                }
                .insetRowBackground()
            }
            if offline {
                Section {
                    Text("Your machine is offline. Nothing can change until it's back.")
                        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        .accessibilityIdentifier("market.installed.offline")
                }
                .insetRowBackground()
            }
            if let page {
                if let empty = page.empty {
                    EmptyState(icon: .storefront, title: "Nothing installed", line: empty)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                } else {
                    Section {
                        if let upToDate = page.upToDate {
                            Text(upToDate).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        }
                        ForEach(page.waiting) { row($0) }
                    } header: { InsetHeader(page.updatesTitle) }
                    .insetRowBackground()
                    if !page.rest.isEmpty {
                        Section { ForEach(page.rest) { row($0) } } header: { InsetHeader("Installed") }
                            .insetRowBackground()
                    }
                }
            } else if problem == nil {
                Section { SkeletonRows(count: 4, label: "Reading what's installed").listRowInsets(EdgeInsets()) }
            }
        }
        .insetGroupedList()
        .animation(.default, value: page)
        .navigationTitle("Installed")
        .navigationBarTitleDisplayMode(.inline)
        .marketRoutes($route, model: model, machineName: machineName)
        .task(id: model.marketGeneration) { await load() }
        .refreshable { await refresh() }
        .sensoryFeedback(AceDesign.Haptic.refresh, trigger: refreshed)
        .sensoryFeedback(.warning, trigger: removed)
        .sensoryFeedback(AceDesign.Haptic.approve, trigger: turnedOn)
        .sheet(item: $updating) { item in
            MarketReviewSheet(model: model, mode: .update(item.install.key), machineName: machineName) { landed in
                updating = nil
                if landed != nil { Task { await load() } }
            }
            .presentationDetents([.medium, .large])
        }
        .confirmationDialog(removing?.removeQuestion ?? "", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }
        ), titleVisibility: .visible, presenting: removing) { item in
            Button("Remove", role: .destructive) { remove(item) }
                .accessibilityIdentifier("market.installed.remove.confirm")
        } message: { Text($0.removeDetail) }
    }

    private func row(_ item: MarketInstalledItem) -> some View {
        let held = offline || working != nil
        return MarketInstalledRow(
            model: model, item: item, machineName: machineName, held: held,
            open: { route = .entry(MarketEntryKey(source: item.install.source, type: item.install.type, name: item.install.name)) },
            update: { updating = item },
            changed: { Task { await load() } }
        )
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if model.canOperate && !held {
                Button("Remove", ace: .trash, role: .destructive) { removing = item }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let word = item.turnOnWord, model.canOperate && !held {
                Button(word, ace: .power) { turnOn(item) }.tint(AceDesign.Ink.action)
            }
        }
    }

    private func reread() { Task { await load() } }

    private func load(fresh: Bool = false) async {
        do {
            page = try await model.market(Self.read, as: MarketInstalledPage.self, fresh: fresh)
            problem = nil
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }

    /// The machine reads its sources again, then Installed is read past the kept answer.
    private func refresh() async {
        refreshed += 1
        do {
            _ = try await model.marketRefresh()
        } catch let refusal as MarketRefusal {
            problem = refusal
            return
        } catch { return }
        await load(fresh: true)
    }

    private func remove(_ item: MarketInstalledItem) {
        change(item) {
            try await model.marketRemove(item.install.key)
            removed += 1
        }
    }

    private func turnOn(_ item: MarketInstalledItem) {
        change(item) {
            _ = try await model.marketTurnOn(item.install.key)
            turnedOn += 1
        }
    }

    /// Runs one row's change, then reads Installed again; a refusal shows its sentence.
    private func change(_ item: MarketInstalledItem, _ run: @escaping () async throws -> Void) {
        working = item.id
        problem = nil
        Task {
            defer { working = nil }
            do {
                try await run()
            } catch let refusal as MarketRefusal {
                problem = refusal
                return
            } catch { return }
            await load(fresh: true)
        }
    }
}
