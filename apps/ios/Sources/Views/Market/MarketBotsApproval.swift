import SwiftUI

/// A Spade skill installed without the person (#2503 fills it): "Installed · Turn on for your
/// bots" with Turn on, which turns exactly that version on. `changed` gets the row after.
struct MarketBotsApproval: View {
    let model: ClientModel
    let install: MarketInstall
    let changed: (MarketInstall) -> Void

    var body: some View {
        Text(install.status).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
    }
}
