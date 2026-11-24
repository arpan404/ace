import SwiftUI

/// Production root: app lock, then the inbox across every paired computer.
struct RootView: View {
    @Bindable var machines: MachinesModel
    @Bindable var lock: AppLock
    @Environment(\.scenePhase) private var phase
    @State private var keeper: BackgroundKeeper?

    var body: some View {
        ZStack {
            content
            if lock.locked { LockView(lock: lock).transition(.opacity) }
            else if phase != .active && lock.enabled { PrivacyCover() }
        }
        .task(id: lock.locked) {
            // Nothing is read or connected until the person unlocks.
            if !lock.locked && !machines.loaded { await machines.load() }
        }
        .onChange(of: machines.machines.isEmpty) { _, empty in if !empty { lock.enable() } }
        .onAppear {
            guard keeper == nil else { return }
            keeper = BackgroundKeeper.system(
                connected: { [machines] in machines.anyConnected }, wake: { [machines] in machines.wake() })
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.backgroundRefreshStatusDidChangeNotification)) { _ in
            keeper?.refreshSetting(UIApplication.shared.backgroundRefreshStatus == .available)
        }
        // UIKit's notifications, not `scenePhase`, for the background hold: see `BackgroundHold`.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            keeper?.resignActive()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            keeper?.enteredBackground()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            keeper?.becameActive()
        }
        .onChange(of: phase) { _, phase in
            LaunchTrace.mark("scene", "\(phase)")
            if phase == .background { lock.didEnterBackground(); machines.inbox.recordSeen() }
            if phase == .active {
                lock.didBecomeActive()
            }
        }
    }
    /// The inbox from the first frame: with no computer paired it offers Add device, and
    /// while the phone is still reading its machines the list shows its loading rows.
    private var content: some View {
        InboxView(inbox: machines.inbox, machines: machines, lock: lock)
            .machineCodePrompt(machines.inbox)
    }
}

struct LockView: View {
    let lock: AppLock
    var body: some View {
        VStack(spacing: AceDesign.Space.margin) {
            AceIcon(.lock, size: AceDesign.Size.icon, relativeTo: .body)
                .foregroundStyle(AceDesign.Ink.muted)
            Text("ace is locked").font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong)).foregroundStyle(AceDesign.Ink.primary)
            if lock.failed {
                Text("Couldn't verify it's you.").font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            Button("Unlock") { Task { await lock.unlock() } }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).disabled(lock.authenticating)
                .accessibilityIdentifier("lock.unlock")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AceDesign.Surface.background)
        .task { await lock.unlock() }
    }
}

/// Hides content from the app switcher snapshot.
struct PrivacyCover: View {
    var body: some View {
        AceDesign.Surface.background.ignoresSafeArea()
            .overlay { Image(ace: .lock).foregroundStyle(AceDesign.Ink.faint).accessibilityHidden(true) }
    }
}
