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
            } else if let refusal = state.refusal, refusal.asksForPerson, !state.exhausted {
                MarketConfirmPerson(refusal: refusal, hostId: model.hostId, busy: state.turning) { turnOn(confirmed: true) }
            } else if let refusal = state.refusal, refusal.way == .computer {
                // Only ace on the computer can get the person's grant this needs.
                Text(refusal.message).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceTheme.StatusText.needsYou).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("market.bots.computer")
            } else if let refusal = state.refusal {
                ProblemRow(refusal.message, detail: refusal.reason, id: "market.bots.problem",
                           retryLabel: state.readsAgain ? "Look again" : "Try again",
                           disabled: state.turning, retry: way(refusal.way))
            }
        }
        // The row was read again with another version: that one starts afresh.
        .onChange(of: install.hash) { state.readAgain() }
    }

    private func way(_ way: MarketWay?) -> (() -> Void)? {
        // A newer version landed, the outcome is unknown, or the one retry was refused: read the
        // row again.
        if state.readsAgain { return { state.lookAgain(); changed(nil) } }
        return way == .retry ? { turnOn(confirmed: false) } : nil
    }

    private func turnOn(confirmed: Bool) {
        guard state.start(confirmed: confirmed) else { return }
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

/// The approval's states: idle, turning on, or refused with its way out. Turn on is held back
/// while it can't help: for a phone sent to pair again or to the computer, after Confirm it's you
/// was refused too, and once a newer version was found, until the row is read with another one.
struct MarketBotsApprovalState: Equatable {
    private(set) var turning = false
    private(set) var refusal: MarketRefusal?
    /// The turn on under way is the person's Confirm it's you.
    private var confirming = false
    /// Confirm it's you was refused too: nothing more is sent for this version.
    private(set) var exhausted = false
    /// The hash this row holds is out of date: a newer version is installed.
    private(set) var stale = false

    func canTurnOn(online: Bool) -> Bool {
        online && !turning && !exhausted && !stale && refusal?.way != .pairAgain && refusal?.way != .computer
    }
    /// The way out is to read the row again.
    var readsAgain: Bool { exhausted || refusal?.way == .reread }

    /// Whether a turn on may start now; false while one is under way or can't help.
    mutating func start(confirmed: Bool) -> Bool {
        guard canTurnOn(online: true) else { return false }
        turning = true
        confirming = confirmed
        return true
    }
    mutating func turnedOn() { self = MarketBotsApprovalState() }
    mutating func refused(_ refusal: MarketRefusal) {
        turning = false
        if confirming, refusal.way == nil || refusal.asksForPerson { exhausted = true }
        if refusal.way == .reread { stale = true }
        confirming = false
        self.refusal = refusal
    }
    /// Look again asked for the row. After a refused Confirm it's you that read starts over. A
    /// stale hash keeps its sentence and Turn on held until the row comes back with another
    /// version, so a read that fails still says why and can be asked again.
    mutating func lookAgain() {
        guard exhausted else { return }
        exhausted = false
        refusal = nil
    }
    /// The row came back with another version, which starts afresh.
    mutating func readAgain() { self = MarketBotsApprovalState() }
}
