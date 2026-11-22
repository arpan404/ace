import SwiftUI
import UIKit

/// A Spade skill installed without the person (spec items 20 and 21, ADR 0178 §12.8): it reaches
/// no bot until the person turns this version on. "Installed · Turn on for your bots", with Turn
/// on as a button that sends exactly this version's hash. A newer version installed since is
/// refused as a conflict and read again; a refusal for standing offers Confirm it's you or Pair
/// again (`MarketConfirmPerson`). `changed` gets the row the machine holds after, or is asked to
/// read again.
struct MarketBotsApproval: View {
    let model: ClientModel
    let install: MarketInstall
    let changed: (MarketInstall?) -> Void
    @State private var state = MarketBotsApprovalState()

    private var online: Bool { model.connection == "ready" }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(spacing: AceDesign.Space.related) {
                Text(install.status).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: AceDesign.Space.related)
                Button(state.turning ? "Turning on…" : "Turn on") { turnOn(confirmed: false) }
                    .buttonStyle(.secondaryAction)
                    .disabled(!state.canTurnOn(online: online && model.canOperate))
                    .accessibilityLabel("Turn \(install.title) on for your bots")
                    .accessibilityIdentifier("market.bots.turnOn.\(install.id)")
            }
            if !online {
                Text("Your machine is offline.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            } else if let refusal = state.refusal, refusal.asksForPerson {
                MarketConfirmPerson(refusal: refusal, hostId: model.hostId, busy: state.turning) { turnOn(confirmed: true) }
            } else if let refusal = state.refusal {
                ProblemRow(refusal.message, detail: refusal.reason, id: "market.bots.problem",
                           retryLabel: refusal.way == .reread ? "Look again" : "Try again",
                           disabled: state.turning, retry: way(refusal.way))
            }
        }
    }

    private func way(_ way: MarketWay?) -> (() -> Void)? {
        switch way {
        // A newer version landed, or the outcome is unknown: read the row again before turning on.
        case .reread: return { state.dismiss(); changed(nil) }
        case .retry: return { turnOn(confirmed: false) }
        default: return nil
        }
    }

    private func turnOn(confirmed: Bool) {
        guard state.start() else { return }
        Task {
            do {
                let row = try await model.marketTurnOnForBots(install, confirmed: confirmed)
                state.turnedOn()
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                changed(row)
            } catch let refused as MarketRefusal {
                state.refused(refused)
            } catch {
                state.refused(MarketRefusal(code: "failed", message: "It didn't turn on. Try again.", way: .retry, offline: false))
            }
        }
    }
}

/// The approval's states: idle, turning on, or refused with its way out. A phone sent to pair
/// again can't turn it on until it is paired again.
struct MarketBotsApprovalState: Equatable {
    private(set) var turning = false
    private(set) var refusal: MarketRefusal?

    func canTurnOn(online: Bool) -> Bool { online && !turning && refusal?.way != .pairAgain }

    /// Whether a turn on may start now; false while one is under way.
    mutating func start() -> Bool {
        guard !turning else { return false }
        turning = true
        return true
    }
    mutating func turnedOn() { turning = false; refusal = nil }
    mutating func refused(_ refusal: MarketRefusal) { turning = false; self.refusal = refusal }
    mutating func dismiss() { refusal = nil }
}
