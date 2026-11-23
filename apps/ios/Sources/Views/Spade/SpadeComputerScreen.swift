import SwiftUI

/// The bot's browser or screen, live (web's `surface-live.tsx`, `surface-picture.tsx`): the
/// pictures come from ace's own live views on the bot's hidden thread, the browser's tab or the
/// computer-use session that thread started, through the phone's native video path. The browser
/// takes the person's touches while they may act; the screen is to watch. Take over and Hand
/// back sit under it. One quiet sentence when there's nothing to show. Pictures stop when the
/// page goes or the app leaves the front.
struct SpadeComputerScreen: View {
    let model: ClientModel
    let watch: SpadeComputerWatch
    /// "browser" or "screen".
    let kind: String
    let name: String
    let face: SpadeModel.Face
    @Environment(\.scenePhase) private var scene
    @State private var screen = RemoteScreen()
    @State private var windowSize: CGSize?

    private var words: String { kind == "browser" ? "browser" : "screen" }
    private var surface: SpadeComputerState.Surface? { watch.state?.surface(kind) }
    private var threadId: String? { watch.state?.threadId }
    private var showing: Bool { scene == .active && model.connection == "ready" }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            picture
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AceDesign.Surface.background)
                .clipShape(AceDesign.Shape.block)
            if kind == "browser", let url = surface?.url {
                Text(url).aceFont(AceDesign.TextRole.code).foregroundStyle(AceDesign.Ink.muted)
                    .lineLimit(1).truncationMode(.middle)
                    .accessibilityLabel("Address \(url)")
            }
            SpadeDriveLineView(model: model, watch: watch, kind: kind, face: face)
        }
        .padding(AceDesign.Space.margin)
        .navigationTitle("\(name)'s \(words)")
        .navigationBarTitleDisplayMode(.inline)
        .followsComputer(watch, model: model)
        .task(id: "\(scene)-\(model.connection)-\(model.connectionEpoch)-\(threadId ?? "")") { await follow() }
        .onDisappear { stop() }
    }

    @ViewBuilder private var picture: some View {
        // Away from the front or the daemon nothing streams; coming back opens it again.
        if watch.state == nil || !showing {
            note("Waiting for \(name)'s \(words)…")
        } else if watch.state?.waking == true, surface?.live != true {
            VStack(spacing: AceDesign.Space.related) {
                SpadeFaceView(face: face, size: AceDesign.Size.spade, pose: .thinking)
                Text("Waking up…").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let threadId {
            if kind == "browser" {
                if surface?.ownChrome == true {
                    note("\(name) is using a tab in your own Chrome.")
                } else {
                    BotBrowserSurface(model: model, threadId: threadId, interactive: showing && watch.mayAct(model),
                                      mayAct: { showing && watch.mayAct(model) })
                        .id("\(threadId)-\(model.connectionEpoch)")
                        .accessibilityLabel("\(name)'s browser")
                        .accessibilityIdentifier("spade.computer.browser.surface")
                }
            } else if let sessionId = screen.live.sessionId, screen.state(sessionId)?.lifecycle == "live" {
                DeviceSurface(next: { screen.live.nextPicture() }, poster: { screen.live.nextPoster() }, interactive: false,
                              label: "\(name)'s screen", identifier: "spade.computer.screen.surface",
                              screenSize: { windowSize = $0 }) { _, _ in }
                    .aspectRatio(windowSize ?? CGSize(width: 16, height: 10), contentMode: .fit)
            } else {
                note(screen.live.waiting ?? "Waiting for \(name)'s screen…")
            }
        } else {
            note("\(name) hasn't opened its \(words) yet.")
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .aceFont(AceDesign.TextRole.rowTitle)
            .foregroundStyle(AceDesign.Ink.muted)
            .multilineTextAlignment(.center)
            .padding(AceDesign.Space.margin)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The screen's pictures: on every refresh, the subscription open now (`live.sessionId`,
    /// nil once one failed) is set to the session the bot's thread holds: none once the bot let
    /// go, the new one when it moved, the same again after a failure. The browser opens from its
    /// surface as it lays out, and closes with it.
    private func follow() async {
        guard showing else { stop(); return }
        stop()
        guard kind == "screen", let threadId else { return }
        while !Task.isCancelled {
            await screen.refresh(model)
            guard !Task.isCancelled else { return }
            let held = screen.states.first { $0.holder?.threadId == threadId }?.sessionId
            if held != screen.live.sessionId {
                stop()
                if let held { await screen.watch(model, id: held) }
                guard !Task.isCancelled else { return }
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    private func stop() {
        if let sessionId = screen.live.sessionId { screen.unwatch(model, id: sessionId) }
    }
}

/// The browser's live page for the bot's hidden thread, drawn by the phone's own surface. It
/// opens the thread's browser at its first size and follows the view's size after.
private struct BotBrowserSurface: UIViewRepresentable {
    let model: ClientModel
    let threadId: String
    /// The person may act: touches go to the page.
    let interactive: Bool
    let mayAct: @MainActor () -> Bool

    final class Coordinator {
        var mayAct: (@MainActor () -> Bool)?
        /// The subscription this surface opened.
        var opened: UUID?
        /// Closes the browser if this subscription is still active.
        var close: (@MainActor (UUID) -> Void)?
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BrowserSurfaceView {
        let view = BrowserSurfaceView()
        let model = model, threadId = threadId, coordinator = context.coordinator
        coordinator.close = { opened in if model.browser.subscription == opened { model.closeBrowser() } }
        view.nextPicture = { [weak browser = model.browser] in browser?.nextPicture() }
        view.nextPoster = { [weak browser = model.browser] in browser?.nextPoster() }
        view.onInput = { inputs in
            guard let opened = coordinator.opened, model.browser.subscription == opened,
                  coordinator.mayAct?() == true else { return }
            model.browserInput(inputs)
        }
        view.onMove = { zoom, offset in model.browser.movePicture(zoom: zoom, offset: offset) }
        view.onLayout = { size, scale, picture in
            if coordinator.opened == nil {
                guard model.browserSession != nil else { return }
                model.openBrowser(size: size, scale: scale, threadId: threadId)
                coordinator.opened = model.browser.subscription
            } else if model.browser.subscription == coordinator.opened {
                model.browserViewport(size: size, scale: scale, picture: picture)
            }
        }
        return view
    }

    func updateUIView(_ view: BrowserSurfaceView, context: Context) {
        context.coordinator.mayAct = mayAct
        view.interactive = interactive
    }

    /// Leaving the page, or the app leaving the front, takes the surface down: the browser this
    /// surface opened closes, and one another view opened since is left alone.
    @MainActor static func dismantleUIView(_ view: BrowserSurfaceView, coordinator: Coordinator) {
        coordinator.mayAct = nil
        view.onLayout = { _, _, _ in }
        view.textField.resignFirstResponder()
        guard let opened = coordinator.opened else { return }
        coordinator.opened = nil
        coordinator.close?(opened)
    }
}
