import SwiftUI

/// The type filter's choices (spec: Everything, Bots, Skills, Plugins, Suits).
enum MarketTypeFilter: String, CaseIterable, Identifiable {
    case everything, bots, skills, plugins, suits
    var id: Self { self }

    var title: String {
        switch self {
        case .everything: "Everything"
        case .bots: "Bots"
        case .skills: "Skills"
        case .plugins: "Plugins"
        case .suits: "Suits"
        }
    }

    /// The market type it narrows to; nil for Everything.
    var type: String? {
        switch self {
        case .everything: nil
        case .bots: "spade-bot"
        case .skills: "spade-skill"
        case .plugins: "spade-plugin"
        case .suits: "suit"
        }
    }

    init(type: String?) {
        self = Self.allCases.first { $0.type == type } ?? .everything
    }
}

/// The type filter as the system's menu in the bar, with the selection haptic (spec item 29).
struct MarketTypeMenu: View {
    @Binding var filter: MarketTypeFilter

    var body: some View {
        Menu {
            Picker("Type", selection: $filter) {
                ForEach(MarketTypeFilter.allCases) { Text($0.title).tag($0) }
            }
        } label: {
            // As every bar draws its buttons: the plain glyph in the body ink, never the accent.
            Image(bar: .funnelSimple).foregroundStyle(AceTheme.Colours.foreground)
        }
        .barGlyph()
        .sensoryFeedback(.selection, trigger: filter)
        .accessibilityLabel("Type: \(filter.title)")
        .accessibilityIdentifier("market.type")
    }
}

/// Search results on the machine's copy of the index (spec item 1): ranked rows, the type
/// filter narrowing them, and No results when there are none; with the machine offline and
/// nothing kept, that the marketplace is offline. `reviewedOnly` keeps entries ace reviewed, as a
/// category lists them.
struct MarketSearchResults: View {
    let model: ClientModel
    let query: String
    let filter: MarketTypeFilter
    var category: String? = nil
    var reviewedOnly = false
    /// Bumped by pull to refresh: reads again past the phone's kept answer.
    var refreshes = 0
    @State private var page: MarketSearchPage?
    @State private var problem: MarketRefusal?
    /// The refresh the last read answered, so a new pull reads past the kept answer.
    @State private var answered = 0

    private var key: String {
        "\(query)|\(filter.rawValue)|\(category ?? "")|\(model.marketGeneration)|\(refreshes)"
    }
    private var rows: [MarketListing] {
        guard let page else { return [] }
        return reviewedOnly ? page.rows.filter(\.reviewed) : page.rows
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let page, !rows.isEmpty {
                MarketStateLine(offline: page.offline, stale: page.listings)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .padding(.bottom, AceDesign.Space.related)
                ForEach(rows) { listing in
                    MarketRow(listing: listing).padding(.horizontal, AceDesign.Space.margin)
                    Divider().padding(.leading, AceDesign.Space.margin)
                }
            } else if page != nil || problem?.offline == true {
                empty.padding(.vertical, AceDesign.Space.section)
            } else if let problem {
                ProblemRow(problem.message, id: "market.search.problem") { Task { await read() } }
            } else {
                SkeletonRows(count: 4, label: "Searching the marketplace")
            }
        }
        .marketUnreachable(page?.offline == true || problem?.offline == true)
        .task(id: key) {
            if !query.isEmpty, (try? await Task.sleep(for: .milliseconds(250))) == nil { return }
            await read()
        }
    }

    @ViewBuilder private var empty: some View {
        if page?.offline == true || problem?.offline == true {
            EmptyState(icon: .wifiSlash, title: "The marketplace is offline",
                       line: "Your machine can't be reached. Results show again when it's back.")
        } else if query.isEmpty {
            EmptyState(icon: .storefront, title: "Nothing here yet", line: "Try another type or category.")
        } else {
            EmptyState.search(query)
        }
    }

    private func read() async {
        do {
            let fresh = refreshes != answered
            page = try await model.marketSearch(query: query, type: filter.type, category: category, fresh: fresh)
            answered = refreshes
            problem = nil
        } catch let refusal as MarketRefusal {
            // Another query's rows never stand in for this one: offline, it says so instead.
            if !Task.isCancelled { page = nil; problem = refusal }
        } catch {}
    }
}

/// Search as its own page (`MarketBrowsePage.search`): opened filtered to one type, as Spade's
/// New bot sheet does for bots; with nothing typed it lists everything of that type.
struct MarketSearchView: View {
    let model: ClientModel
    let machineName: String
    @State private var filter: MarketTypeFilter
    @State private var query = ""
    @State private var refreshes = 0

    init(model: ClientModel, type: String?, machineName: String) {
        self.model = model
        self.machineName = machineName
        _filter = State(initialValue: MarketTypeFilter(type: type))
    }

    var body: some View {
        ScrollView {
            MarketSearchResults(model: model, query: query, filter: filter, refreshes: refreshes)
                .padding(.top, AceDesign.Space.related)
        }
        .background(AceDesign.Surface.background)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search the marketplace")
        .refreshable {
            _ = try? await model.marketRefresh()
            refreshes += 1
        }
        .sensoryFeedback(AceDesign.Haptic.refresh, trigger: refreshes)
        .navigationTitle(filter == .everything ? "Search" : filter.title)
        .navigationBarTitleDisplayMode(.large)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { MarketTypeMenu(filter: $filter) } }
        .marketBrowseActions(model: model, machineName: machineName)
    }
}
