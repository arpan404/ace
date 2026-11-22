import SwiftUI

/// The Marketplace's home on one machine (spec items 1 to 5, 19, 27 to 30): Discover's hero and
/// shelves (Featured, Trending this week, New and notable, collections, top publishers), then the
/// categories, Installed with how many updates wait, and the sources. With Discover failing or
/// empty it shows the device's own listings. Typing in the search field under the title swaps
/// the shelves for ranked results, narrowed by the type filter. It draws what this phone last
/// kept first and reads again when the market changes; pull to refresh has the machine read its
/// sources again.
struct MarketHomeView: View {
    let model: ClientModel
    /// The machine the market is on, by name: where an install lands.
    let machineName: String
    @State private var discover: MarketDiscover?
    @State private var home: MarketHome?
    @State private var stale: String?
    @State private var problem: MarketRefusal?
    @State private var query = ""
    @State private var filter = MarketTypeFilter.everything
    @State private var refreshes = 0
    /// The last read or refresh came back offline though the socket may still read ready.
    @State private var unreachable = false

    init(model: ClientModel, machineName: String) {
        self.model = model
        self.machineName = machineName
        _discover = State(initialValue: model.keptMarketDiscover)
        _home = State(initialValue: model.keptMarketHome)
        _stale = State(initialValue: model.keptMarketSources?.stale)
    }

    private var offline: Bool {
        model.connection != "ready" || unreachable || discover?.offline == true || home?.offline == true
    }
    /// Discover, unless it failed or has nothing; then the device's listings carry the home.
    private var shelves: MarketDiscover? { discover.flatMap { $0.empty ? nil : $0 } }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty || filter != .everything }

    var body: some View {
        ScrollView {
            if searching {
                MarketSearchResults(model: model, query: query.trimmingCharacters(in: .whitespaces), filter: filter,
                                    refreshes: refreshes)
                    .padding(.top, AceDesign.Space.related)
            } else {
                content.marketUnreachable(offline)
            }
        }
        .background(AceDesign.Surface.background)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Bots, skills, plugins and Suits")
        .refreshable { await refresh() }
        .sensoryFeedback(AceDesign.Haptic.refresh, trigger: refreshes)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { MarketTypeMenu(filter: $filter) } }
        .marketBrowseActions(model: model, machineName: machineName)
        .task(id: model.marketGeneration) { await readAgain() }
    }

    private var content: some View {
        LazyVStack(alignment: .leading, spacing: AceDesign.Space.section) {
            if offline || stale != nil {
                MarketStateLine(offline: offline, stale: stale).padding(.horizontal, AceDesign.Space.margin)
            }
            // A failed read or refresh shows over what the home last found, with its way out.
            if let problem {
                ProblemRow(problem.message, id: "market.home.problem") { Task { await refresh() } }
            }
            if let shelves {
                discoverShelves(shelves)
            } else if let home {
                MarketShelf(title: "Featured", items: home.featured) { MarketRow(listing: $0) }
            } else if problem == nil {
                SkeletonRows(count: 5, label: "Reading the marketplace")
            }
            if let home { categories(home) }
            places
        }
        .padding(.vertical, AceDesign.Space.related)
    }

    @ViewBuilder private func discoverShelves(_ discover: MarketDiscover) -> some View {
        if let hero = discover.hero { MarketHero(listing: hero) }
        MarketShelf(title: "Featured", items: discover.featured) { MarketRow(listing: $0) }
        MarketShelf(title: "Trending this week", items: discover.trending) {
            MarketRow(listing: $0.row, rank: $0.rank, note: $0.movement)
        }
        MarketShelf(title: "New and notable", items: discover.fresh) { MarketRow(listing: $0) }
        ForEach(discover.collections) { collection in
            MarketShelf(title: collection.title, line: collection.line, items: collection.rows) { MarketRow(listing: $0) }
        }
        MarketPublishers(publishers: discover.publishers)
    }

    @ViewBuilder private func categories(_ home: MarketHome) -> some View {
        if !home.categories.isEmpty {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                MarketShelfHeader(title: "Categories").padding(.bottom, AceDesign.Space.tight)
                ForEach(home.categories) { category in
                    MarketPlaceRow(title: category.title, value: category.countText,
                                   route: .browse(.category(id: category.id, title: category.title)))
                        .accessibilityIdentifier("market.category.\(category.id)")
                }
            }
        }
    }

    private var places: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            MarketPlaceRow(title: "Installed", icon: .package, value: home?.updatesText, route: .installed)
                .accessibilityIdentifier("market.installed")
            MarketPlaceRow(title: "Sources", icon: .database, value: nil, route: .browse(.sources))
                .accessibilityIdentifier("market.sources")
        }
    }

    /// Pull to refresh: the machine reads its sources again, then the home reads fresh. A refusal
    /// of either shows over the shelves with Try again; it never leaves old shelves looking new.
    private func refresh() async {
        var refused: MarketRefusal?
        do { _ = try await model.marketRefresh() } catch let failed as MarketRefusal { refused = failed } catch {}
        let read = await load(fresh: true)
        guard !Task.isCancelled else { return }
        problem = refused ?? read
        if refused?.offline == true { unreachable = true }
        refreshes += 1
    }

    /// The market changed: read again from what the phone keeps.
    private func readAgain() async {
        let refusal = await load(fresh: false)
        if !Task.isCancelled { problem = refusal }
    }

    /// Discover, the device's own listings (for categories and the updates word) and the sources'
    /// last read, each kept apart: one failing never hides what another found. Discover failing
    /// is no problem while the device's listings stand in for it. Answers the refusal to show.
    private func load(fresh: Bool) async -> MarketRefusal? {
        async let discovered = model.marketDiscover(fresh: fresh)
        async let listed = model.marketHome(fresh: fresh)
        async let read = model.marketSources(fresh: fresh)
        var discoverRefusal: MarketRefusal?
        var homeRefusal: MarketRefusal?
        var answeredOffline = false
        do {
            let answer = try await discovered
            discover = answer
            answeredOffline = answer.offline
        } catch let failed as MarketRefusal {
            discoverRefusal = failed
            if !failed.offline { discover = nil }
        } catch {}
        do {
            let answer = try await listed
            home = answer
            answeredOffline = answeredOffline || answer.offline
        } catch let failed as MarketRefusal { homeRefusal = failed } catch {}
        if let sources = try? await read { stale = sources.stale }
        guard !Task.isCancelled else { return nil }
        unreachable = answeredOffline || discoverRefusal?.offline == true || homeRefusal?.offline == true
        // Offline with something kept, the state line says so; a refusal only shows otherwise.
        let refusal = homeRefusal ?? (shelves == nil && home == nil ? discoverRefusal : nil)
        if let refusal, refusal.offline, shelves != nil || home != nil { return nil }
        return refusal
    }
}

/// A row of the home that opens a page: categories, Installed, Sources. Full width, a tap tall.
struct MarketPlaceRow: View {
    let title: String
    var icon: AceIcon.Name? = nil
    let value: String?
    let route: MarketRoute
    @Environment(\.marketRows) private var rows

    var body: some View {
        Button { rows.open(route) } label: {
            InsetRow(icon: icon, title: title) {
                HStack(spacing: AceDesign.Space.related) {
                    if let value {
                        Text(value).aceFont(AceDesign.TextRole.action).foregroundStyle(AceDesign.Ink.muted)
                    }
                    RowCaret()
                }
            }
            .frame(minHeight: AceDesign.Size.tap)
            .padding(.horizontal, AceDesign.Space.margin)
        }
        .buttonStyle(.plain)
    }
}

/// Discover's hero: the one entry the market leads with, its picture large, then its row.
struct MarketHero: View {
    let listing: MarketListing
    @Environment(\.marketRows) private var rows
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if !typeSize.isAccessibilitySize {
                Button { rows.open(.entry(listing.key)) } label: {
                    GeometryReader { space in
                        MarketPictureView(hash: listing.picture, kind: "preview", size: space.size.width) {
                            AceIcon(MarketListingIcon.glyph(listing.type), size: AceDesign.Size.emptyIcon * 2, relativeTo: .largeTitle)
                                .foregroundStyle(AceDesign.Ink.faint)
                        }
                        .frame(height: space.size.height).clipped()
                        .clipShape(AceDesign.Shape.block)
                    }
                    .aspectRatio(16 / 9, contentMode: .fit)
                }
                .buttonStyle(.plain)
                .accessibilityHidden(true)
            }
            MarketRow(listing: listing)
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }
}

/// Top publishers: their pictures and names in a sideways row, each opening their page; a list
/// at accessibility sizes.
struct MarketPublishers: View {
    let publishers: [MarketDiscover.Publisher]
    @Environment(\.marketRows) private var rows
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if !publishers.isEmpty {
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                MarketShelfHeader(title: "Top publishers")
                if typeSize.isAccessibilitySize {
                    ForEach(publishers) { publisher in
                        MarketPlaceRow(title: publisher.name, value: publisher.entriesText,
                                       route: .browse(.publisher(handle: publisher.handle)))
                    }
                } else {
                    ScrollView(.horizontal) {
                        LazyHStack(alignment: .top, spacing: AceDesign.Space.margin) {
                            ForEach(publishers) { card($0) }
                        }
                    }
                    .scrollIndicators(.hidden)
                    .contentMargins(.horizontal, AceDesign.Space.margin, for: .scrollContent)
                }
            }
        }
    }

    private func card(_ publisher: MarketDiscover.Publisher) -> some View {
        Button { rows.open(.browse(.publisher(handle: publisher.handle))) } label: {
            VStack(spacing: AceDesign.Space.tight) {
                MarketPictureView(hash: publisher.avatar, kind: "avatar", size: AceDesign.Size.profileAvatar, round: true) {
                    AceIcon(.user, size: AceDesign.Size.emptyIcon, relativeTo: .title2).foregroundStyle(AceDesign.Ink.muted)
                }
                HStack(spacing: AceDesign.Space.tight) {
                    Text(publisher.name).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    if publisher.verified || publisher.official {
                        AceIcon(.sealCheck, size: AceDesign.Size.glyphSmall, relativeTo: .caption).foregroundStyle(AceDesign.Ink.action)
                    }
                }
                Text(publisher.entriesText).aceFont(AceDesign.TextRole.caption).foregroundStyle(AceDesign.Ink.subtle)
            }
            .frame(width: AceDesign.Size.profileAvatar + AceDesign.Space.group)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([publisher.name, publisher.verified ? "Verified" : nil, publisher.entriesText]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}

/// Browse's pages past the home: search, a category, a publisher, the sources.
struct MarketBrowseView: View {
    let model: ClientModel
    let page: MarketBrowsePage
    let machineName: String

    var body: some View {
        switch page {
        case .search(let type): MarketSearchView(model: model, type: type, machineName: machineName)
        case .category(let id, let title): MarketCategoryView(model: model, id: id, title: title, machineName: machineName)
        case .publisher(let handle): MarketPublisherView(model: model, handle: handle, machineName: machineName)
        case .sources: MarketSourcesView(model: model, machineName: machineName)
        }
    }
}
