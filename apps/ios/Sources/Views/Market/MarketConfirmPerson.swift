import SwiftUI

/// A market change refused for the person's standing (spec items 14 and 23, ADR 0190 §7), with
/// its way out. Confirm it's you sends the change once more: the socket proves standing itself,
/// and the bridge stops after that one retry. A phone the machine can't take standing from is sent
/// to Pair again, on the machine's row in Settings › Machines.
struct MarketConfirmPerson: View {
    let refusal: MarketRefusal
    /// The machine the change was refused on, whose row offers Pair again.
    let hostId: String?
    /// The retry or a change is already under way.
    var busy = false
    /// Sends the change once more, as confirmed.
    let confirm: () -> Void
    @Environment(\.settingsPush) private var push

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(refusal.message).aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceTheme.StatusText.needsYou).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("market.person.sentence")
            switch refusal.way {
            case .confirm:
                Button("Confirm it's you", action: confirm)
                    .buttonStyle(.secondaryAction).disabled(busy)
                    .accessibilityIdentifier("market.person.confirm")
            case .pairAgain:
                if let hostId {
                    Button("Pair again") { push(.machine(hostId)) }
                        .buttonStyle(.secondaryAction)
                        .accessibilityHint("Opens this machine in Settings, where it can be paired again.")
                        .accessibilityIdentifier("market.person.pairAgain")
                }
            default:
                EmptyView()
            }
        }
    }
}
