import SwiftUI

/// What a market row reaches from wherever it is drawn: whether the market can be reached, and
/// the page's own ways to open a page, start a review and remove an installed copy. Each browse
/// screen sets it with `marketBrowseActions`, and marks it offline with `marketUnreachable` when
/// an answer came back offline while the socket stayed up.
struct MarketRows {
    var model: ClientModel?
    var offline = false
    var open: (MarketRoute) -> Void = { _ in }
    /// Get or Update: the review sheet, titled by the listing.
    var get: (MarketReviewSheet.Mode, String) -> Void = { _, _ in }
    /// Remove one installed copy, after the person confirms its question.
    var remove: (MarketListingAction.Copy) -> Void = { _ in }
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

    /// Disables these rows' Get, Update and Remove while `unreachable`: an answer came back
    /// offline (a read timed out) though the socket still reads ready.
    func marketUnreachable(_ unreachable: Bool) -> some View {
        transformEnvironment(\.marketRows) { $0.offline = $0.offline || unreachable }
    }
}

private struct MarketBrowseActions: ViewModifier {
    struct Review: Identifiable {
        let mode: MarketReviewSheet.Mode
        let title: String
        var id: MarketReviewSheet.Mode { mode }
    }

    let model: ClientModel
    let machineName: String
    @State private var route: MarketRoute?
    @State private var review: Review?
    @State private var removing: MarketListingAction.Copy?
    @State private var removed = 0
    @State private var problem: MarketRefusal?
    /// A change came back offline: Get, Update and Remove stay off until a read answers.
    @State private var unreachable = false

    func body(content: Content) -> some View {
        content
            .environment(\.marketRows, MarketRows(
                model: model, offline: model.connection != "ready" || unreachable,
                open: { route = $0 },
                get: { review = Review(mode: $0, title: $1) },
                remove: { removing = $0 }))
            .marketRoutes($route, model: model, machineName: machineName)
            .sheet(item: $review) { review in
                MarketReviewSheet(model: model, mode: review.mode, machineName: machineName) { _ in
                    self.review = nil
                }
                .presentationDetents([.medium, .large])
            }
            .confirmationDialog(removing?.question ?? "", isPresented: Binding(
                get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible,
                presenting: removing) { copy in
                Button("Remove", role: .destructive) { Task { await remove(copy) } }
                    .accessibilityIdentifier("market.remove.confirm")
            }
            .alert(problem?.message ?? "", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .sensoryFeedback(.warning, trigger: removed)
            // The market changed: whatever reads again says whether it is reachable.
            .onChange(of: model.marketGeneration) { unreachable = false }
            .onChange(of: model.connection) { unreachable = false }
    }

    /// Removes exactly the chosen copy: a bot package's by its bot.
    private func remove(_ copy: MarketListingAction.Copy) async {
        do {
            try await model.marketRemove(copy.install.key)
            removed += 1
        } catch let refusal as MarketRefusal {
            if refusal.offline { unreachable = true }
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
