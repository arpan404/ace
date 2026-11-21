import SwiftUI

/// What a market row reaches from wherever it is drawn: the machine's installs (for its button),
/// whether the machine can be reached, and the page's own ways to open a page, start a review
/// and remove an install. Each browse screen sets it with `marketBrowseActions`.
struct MarketRows {
    var model: ClientModel?
    var installed: [MarketInstall] = []
    var offline = false
    var open: (MarketRoute) -> Void = { _ in }
    /// Get or Update: the review sheet, titled by the listing.
    var get: (MarketReviewSheet.Mode, String) -> Void = { _, _ in }
    /// Remove, after the person confirms what goes.
    var remove: (MarketInstall, String) -> Void = { _, _ in }
}

extension EnvironmentValues {
    @Entry var marketRows = MarketRows()
}

extension View {
    /// Gives this screen's market rows their button state and actions, on `model`'s machine: its
    /// own pushed pages, the review sheet for Get and Update, and Remove's confirmation.
    func marketBrowseActions(model: ClientModel, machineName: String) -> some View {
        modifier(MarketBrowseActions(model: model, machineName: machineName))
    }
}

private struct MarketBrowseActions: ViewModifier {
    struct Review: Identifiable {
        let mode: MarketReviewSheet.Mode
        let title: String
        var id: MarketReviewSheet.Mode { mode }
    }
    struct Removal: Identifiable {
        let install: MarketInstall
        let title: String
        var id: String { install.id }
    }

    let model: ClientModel
    let machineName: String
    @State private var route: MarketRoute?
    @State private var review: Review?
    @State private var removing: Removal?
    @State private var installed: [MarketInstall]
    @State private var removed = 0
    @State private var problem: MarketRefusal?

    init(model: ClientModel, machineName: String) {
        self.model = model
        self.machineName = machineName
        _installed = State(initialValue: model.keptMarketInstalled?.rows ?? [])
    }

    func body(content: Content) -> some View {
        content
            .environment(\.marketRows, MarketRows(
                model: model, installed: installed, offline: model.connection != "ready",
                open: { route = $0 },
                get: { review = Review(mode: $0, title: $1) },
                remove: { removing = Removal(install: $0, title: $1) }))
            .marketRoutes($route, model: model, machineName: machineName)
            .sheet(item: $review) { review in
                MarketReviewSheet(model: model, mode: review.mode, machineName: machineName) { _ in
                    self.review = nil
                }
                .presentationDetents([.medium, .large])
            }
            .confirmationDialog(removing.map(Self.question) ?? "", isPresented: Binding(
                get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible,
                presenting: removing) { removal in
                Button("Remove", role: .destructive) { Task { await remove(removal.install) } }
                    .accessibilityIdentifier("market.remove.confirm")
            }
            .alert(problem?.message ?? "", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .sensoryFeedback(.warning, trigger: removed)
            .task(id: model.marketGeneration) { await readInstalled() }
    }

    /// "Remove Inbox's skills and plugins? The bot stays yours." for a bot; "Remove Triage?" else.
    private static func question(_ removal: Removal) -> String {
        removal.install.type == "spade-bot"
            ? "Remove \(removal.title)'s skills and plugins? The bot stays yours."
            : "Remove \(removal.title)?"
    }

    private func readInstalled() async {
        if let list = try? await model.marketInstalled() { installed = list.rows }
    }

    private func remove(_ install: MarketInstall) async {
        do {
            try await model.marketRemove(install.key)
            removed += 1
            installed.removeAll { $0.id == install.id }
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}

/// The one line every browse screen shows while the machine can't be reached, over what it
/// last kept (spec item 4); or, with the machine online and a source unreadable, when the
/// listings were last read (spec item 5).
struct MarketStateLine: View {
    let offline: Bool
    /// "Listings from 3:04 PM".
    var stale: String? = nil

    var body: some View {
        if let words {
            Text(words).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("market.state")
        }
    }

    private var words: String? {
        if offline { return "Your machine is offline. Get and Update wait until it's back." }
        return stale
    }
}
