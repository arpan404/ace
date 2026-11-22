import SwiftUI

/// Everything installed from the market on this machine (spec items 16 to 19): updates first,
/// each row's type, version and machine, a withdrawn entry off with its reason. Swipe to remove
/// (asked first), or to turn back on what the person turned off; a withdrawn entry comes back
/// only from the row's menu, through a question naming its publisher's reason. Update opens the
/// review in update mode; pull to refresh has the machine read its sources again. While the
/// machine can't be reached it shows what this phone kept and nothing can change.
struct MarketInstalledView: View {
    let model: ClientModel
    let machineName: String
    @State private var page: MarketInstalledPage?
    @State private var problem: MarketRefusal?
    @State private var route: MarketRoute?
    @State private var updating: MarketInstalledItem?
    @State private var asking: Asking?
    /// The row whose change is under way.
    @State private var working: String?
    @State private var removed = 0
    @State private var turnedOn = 0
    @State private var refreshed = 0

    /// The one question open over the list.
    private enum Asking: Hashable {
        case remove(MarketInstalledItem)
        /// A withdrawn entry, back on at the person's own risk.
        case restore(MarketInstalledItem, MarketInstalledItem.Ask)
    }

    init(model: ClientModel, machineName: String) {
        self.model = model
        self.machineName = machineName
        _page = State(initialValue: model.keptMarket(Self.read, as: MarketInstalledPage.self))
    }

    private static var read: [String: Any] { ["op": "installed"] }
    /// Off the machine now, or showing an answer kept from when it was reachable.
    private var offline: Bool { model.connection != "ready" || (page?.offline ?? false) }
    /// Nothing can be pressed: offline, read-only, or a change already under way.
    private var held: Bool { offline || !model.canOperate || working != nil }

    var body: some View {
        List {
            problemSection
            offlineSection
            listSections
        }
        .insetGroupedList()
        .animation(.default, value: page)
        .navigationTitle("Installed")
        .navigationBarTitleDisplayMode(.inline)
        .marketRoutes($route, model: model, machineName: machineName)
        .task(id: model.marketGeneration) { await load() }
        .refreshable { await refresh() }
        // A question asked while connected can't be answered once the machine is gone.
        .onChange(of: model.connection) { _, connection in if connection != "ready" { asking = nil } }
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
        .confirmationDialog(question, isPresented: Binding(
            get: { asking != nil }, set: { if !$0 { asking = nil } }
        ), titleVisibility: .visible, presenting: asking) { asked in
            switch asked {
            case .remove(let item):
                Button("Remove", role: .destructive) { remove(item) }
                    .disabled(held)
                    .accessibilityIdentifier("market.installed.remove.confirm")
            case .restore(let item, let ask):
                Button(ask.confirm, role: .destructive) { turnOn(item) }
                    .disabled(held)
                    .accessibilityIdentifier("market.installed.restore.confirm")
            }
        } message: { asked in
            switch asked {
            case .remove(let item): Text(item.removeDetail)
            case .restore(_, let ask): Text(ask.detail)
            }
        }
    }

    @ViewBuilder private var problemSection: some View {
        if let problem {
            Section {
                ProblemRow(problem.message, id: "market.installed.problem", retry: retryProblem)
            }
            .insetRowBackground()
        }
    }

    @ViewBuilder private var offlineSection: some View {
        if offline {
            Section {
                Text("Your machine is offline. Nothing can change until it's back.")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("market.installed.offline")
            }
            .insetRowBackground()
        }
    }

    @ViewBuilder private var listSections: some View {
        if let page {
            if let empty = page.empty {
                emptyState(empty)
            } else {
                updatesSection(page)
                restSection(page)
            }
        } else if problem == nil {
            Section { SkeletonRows(count: 4, label: "Reading what's installed").listRowInsets(EdgeInsets()) }
        }
    }

    private func emptyState(_ line: String) -> some View {
        EmptyState(icon: .storefront, title: "Nothing installed", line: line)
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
    }

    private func updatesSection(_ page: MarketInstalledPage) -> some View {
        Section {
            if let upToDate = page.upToDate {
                Text(upToDate).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            ForEach(page.waiting) { row($0) }
        } header: { InsetHeader(page.updatesTitle) }
        .insetRowBackground()
    }

    @ViewBuilder private func restSection(_ page: MarketInstalledPage) -> some View {
        if !page.rest.isEmpty {
            Section { ForEach(page.rest) { row($0) } } header: { InsetHeader("Installed") }
                .insetRowBackground()
        }
    }

    private var question: String {
        switch asking {
        case .remove(let item): item.removeQuestion
        case .restore(_, let ask): ask.question
        case nil: ""
        }
    }

    private func row(_ item: MarketInstalledItem) -> some View {
        MarketInstalledRow(
            model: model, item: item, machineName: machineName, held: held,
            open: { route = .entry(MarketEntryKey(source: item.install.source, type: item.install.type, name: item.install.name)) },
            update: { if !held { updating = item } },
            changed: { Task { await load() } }
        )
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !held { Button("Remove", ace: .trash, role: .destructive) { asking = .remove(item) } }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            // Only what the person turned off comes back in one step.
            if let word = item.turnOnWord, item.turnOnQuick, !held {
                Button(word, ace: .power) { turnOn(item) }.tint(AceDesign.Ink.action)
            }
        }
        .contextMenu {
            if !held {
                if let word = item.turnOnWord, let ask = item.turnOnAsk {
                    Button(word, ace: .power) { asking = .restore(item, ask) }
                } else if let word = item.turnOnWord {
                    Button(word, ace: .power) { turnOn(item) }
                }
                Button("Remove", ace: .trash, role: .destructive) { asking = .remove(item) }
            }
        }
    }

    /// Try again, for a refusal whose way out is to ask again.
    private var retryProblem: (() -> Void)? {
        guard problem?.way == .retry else { return nil }
        return { Task { await load() } }
    }

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

    /// Runs one row's change, then reads Installed again; a refusal shows its sentence. Nothing
    /// starts while the machine can't be reached or another change is under way.
    private func change(_ item: MarketInstalledItem, _ run: @escaping () async throws -> Void) {
        guard !held else { return }
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
