import SwiftUI

/// Where the machine's market reads from: ace's marketplace and any git catalog the person
/// added, each with when it was last read and why its last read failed. Each turns on and off,
/// reads again with a swipe or the pull, and a git catalog is added by its https address and
/// removed. A refusal shows the daemon's sentence and changes nothing.
struct MarketSourcesView: View {
    let model: ClientModel
    let machineName: String
    @State private var sources: MarketSources?
    @State private var problem: MarketRefusal?
    @State private var address = ""
    @State private var adding = false
    @State private var addProblem: MarketRefusal?
    @State private var removing: MarketSources.Source?
    @State private var refreshes = 0
    @State private var removed = 0

    init(model: ClientModel, machineName: String) {
        self.model = model
        self.machineName = machineName
        _sources = State(initialValue: model.keptMarketSources)
    }

    private var offline: Bool { model.connection != "ready" || sources?.offline == true }

    var body: some View {
        List {
            if offline || sources?.stale != nil {
                Section { MarketStateLine(offline: offline, stale: sources?.stale) }
                    .listRowBackground(Color.clear)
            }
            if let problem {
                Section { ProblemRow(problem.message, id: "market.sources.problem") { Task { await load(fresh: true) } } }
            }
            if let sources {
                Section {
                    ForEach(sources.sources) { row($0) }
                } footer: {
                    Text("Swipe a catalog to read it again.")
                }
                .insetRowBackground()
            } else if problem == nil {
                Section { SkeletonRows(count: 2, label: "Reading the sources").listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)
            }
            addSection
        }
        .insetGroupedList()
        .refreshable {
            await change { try await model.marketRefresh() }
            refreshes += 1
        }
        .sensoryFeedback(AceDesign.Haptic.refresh, trigger: refreshes)
        .sensoryFeedback(.warning, trigger: removed)
        .navigationTitle("Sources")
        .navigationBarTitleDisplayMode(.large)
        .confirmationDialog("Remove \(removing?.title ?? "this catalog")?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible,
            presenting: removing) { source in
            Button("Remove", role: .destructive) {
                Task {
                    if await change({ try await model.marketRemoveSource(source.id) }) { removed += 1 }
                }
            }
        } message: { _ in
            Text("Its entries leave the marketplace. What you installed from it stays.")
        }
        .task(id: model.marketGeneration) { await load(fresh: false) }
    }

    private func row(_ source: MarketSources.Source) -> some View {
        Toggle(isOn: Binding(get: { source.enabled }, set: { on in
            Task { await change { try await model.marketSetSource(source.id, enabled: on) } }
        })) {
            VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                Text(source.title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                    .lineLimit(2).truncationMode(.middle)
                Text("\(source.entriesText) · \(source.listings)").aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                if let problem = source.problem {
                    Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(minHeight: AceDesign.Size.tap, alignment: .leading)
        }
        .disabled(offline)
        .accessibilityIdentifier("market.source.\(source.id)")
        .swipeActions(edge: .trailing) {
            if source.removable {
                Button(role: .destructive) { removing = source } label: { Label("Remove", ace: .trash) }
            }
            Button { Task { await change { try await model.marketRefresh(source.id) } } } label: {
                Label("Read again", ace: .arrowClockwise)
            }
            .tint(AceDesign.Ink.action)
        }
    }

    private var addSection: some View {
        Section {
            TextField("https://example.com/catalog.git", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit { Task { await add() } }
                .accessibilityLabel("Catalog address")
                .accessibilityIdentifier("market.sources.address")
            Button(adding ? "Adding…" : "Add catalog") { Task { await add() } }
                .buttonStyle(.rowAction)
                .disabled(offline || adding || address.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("market.sources.add")
            if let addProblem {
                ProblemRow(addProblem.message, id: "market.sources.add.problem")
            }
        } header: {
            Text("Add a git catalog")
        } footer: {
            Text("Its entries are listed beside ace's marketplace, marked with where they come from.")
        }
        .insetRowBackground()
    }

    private func add() async {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !adding else { return }
        adding = true
        defer { adding = false }
        do {
            sources = try await model.marketAddSource(trimmed)
            address = ""
            addProblem = nil
        } catch let refusal as MarketRefusal {
            addProblem = refusal
        } catch {}
    }

    /// Runs one change to the sources; its answer is the new list. A refusal changes nothing.
    @discardableResult private func change(_ run: () async throws -> MarketSources) async -> Bool {
        do {
            sources = try await run()
            problem = nil
            return true
        } catch let refusal as MarketRefusal {
            problem = refusal
            return false
        } catch { return false }
    }

    private func load(fresh: Bool) async {
        do {
            sources = try await model.marketSources(fresh: fresh)
            problem = nil
        } catch let refusal as MarketRefusal {
            if !Task.isCancelled { problem = refusal }
        } catch {}
    }
}
