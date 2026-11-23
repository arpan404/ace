import SwiftUI

/// Why a change to the bot's files can't be made now: the computer is changing hands.
let spadeNotNowToChange = "Files can change once the computer is yours or shared again"

/// Who has the computer, under what it shows (web's `drive-line.tsx`): the bot's face, moving,
/// and "Writer is using the browser" with Take over while it drives; "You have the browser" with
/// Hand back once the person took over; "Stopping Writer…" while its work ends. While neither
/// uses it, one quiet sentence, with no face and no button.
struct SpadeDriveLineView: View {
    let model: ClientModel
    let watch: SpadeComputerWatch
    /// "browser", "screen", "terminal" or "files": which surface's line.
    let kind: String
    let face: SpadeModel.Face

    var body: some View {
        if let drive = watch.state?.drive[kind] {
            if let action = drive.action {
                HStack(spacing: AceDesign.Space.related) {
                    if drive.face { SpadeFaceView(face: face, size: AceDesign.Size.emptyIcon, pose: .working) }
                    Text(drive.sentence)
                        .aceFont(AceDesign.TextRole.segment)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(action == "hand-back" ? "Hand back" : "Take over") {
                        let take = action != "hand-back"
                        Task { await watch.take(epoch: model.connectionEpoch) { await model.spadeComputerTake(watch.agent, take: take) } }
                    }
                    .buttonStyle(.secondaryAction)
                    .frame(minHeight: AceDesign.Size.tap)
                    .disabled(watch.pending || model.connection != "ready" || !model.canOperate)
                    .accessibilityIdentifier("spade.computer.\(action)")
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            } else {
                Text(drive.sentence)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

extension View {
    /// Follows the bot's computer while this page shows with the app in front, and says what Take
    /// over or Hand back met.
    func followsComputer(_ watch: SpadeComputerWatch, model: ClientModel) -> some View {
        modifier(FollowsComputer(watch: watch, model: model))
    }
}

private struct FollowsComputer: ViewModifier {
    let watch: SpadeComputerWatch
    let model: ClientModel
    @Environment(\.scenePhase) private var scene

    func body(content: Content) -> some View {
        content
            .task(id: "\(scene)-\(model.connection)-\(model.connectionEpoch)") {
                // The app left the front or the connection changed: what Spade said before may be
                // out of date, so no input goes in until a fresh read.
                watch.forget()
                guard scene == .active, model.connection == "ready" else { return }
                await watch.follow(epoch: model.connectionEpoch) { await model.spadeComputerRead(watch.agent) }
            }
            .task(id: watch.readAt) {
                if let stamp = watch.readAt { await watch.expire(stamp) }
            }
            .alert("That didn't go", isPresented: Binding(get: { watch.problem != nil }, set: { if !$0 { watch.problem = nil } })) {
                Button("Close", role: .cancel) { watch.problem = nil }
            } message: { Text(watch.problem ?? "") }
    }
}
