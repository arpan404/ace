import SwiftUI

/// One category's entries ace has reviewed, every type, narrowed by the type filter.
struct MarketCategoryView: View {
    let model: ClientModel
    let id: String
    let title: String
    let machineName: String
    @State private var filter = MarketTypeFilter.everything
    @State private var refreshes = 0

    var body: some View {
        ScrollView {
            MarketSearchResults(model: model, query: "", filter: filter, category: id, reviewedOnly: true,
                                refreshes: refreshes)
                .padding(.top, AceDesign.Space.related)
        }
        .background(AceDesign.Surface.background)
        .refreshable {
            _ = try? await model.marketRefresh()
            refreshes += 1
        }
        .sensoryFeedback(AceDesign.Haptic.refresh, trigger: refreshes)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.large)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { MarketTypeMenu(filter: $filter) } }
        .marketBrowseActions(model: model, machineName: machineName)
    }
}
