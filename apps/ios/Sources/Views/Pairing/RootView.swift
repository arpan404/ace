import SwiftUI

/// Production root: app lock, then onboarding or the inbox across every paired computer.
struct RootView: View {
    @Bindable var machines: MachinesModel
    @Bindable var lock: AppLock
    @Environment(\.scenePhase) private var phase
    @State private var backgrounded = false

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
        .onChange(of: phase) { _, phase in
            LaunchTrace.mark("scene", "\(phase)")
            if phase == .background { lock.didEnterBackground(); machines.inbox.recordSeen(); backgrounded = true }
            if phase == .active {
                lock.didBecomeActive()
                // Inactive sits between background and active, so the visit is remembered.
                if backgrounded { backgrounded = false; machines.wake() }
            }
        }
    }
    @ViewBuilder private var content: some View {
        if !machines.loaded {
            AceTheme.Colours.background.ignoresSafeArea()
        } else if machines.machines.isEmpty {
            NavigationStack {
                VStack(spacing: AceTheme.Spacing.none) {
                    ContentUnavailableView("Your agents, with you", systemImage: "point.3.connected.trianglepath.dotted",
                                           description: Text("Pair this phone with ace on your own computer, over your network or Tailscale."))
                        .frame(maxHeight: 260)
                    PairingView(machines: machines)
                }
                .background(AceTheme.Colours.background)
            }
            .tint(AceTheme.Colours.foreground)
        } else {
            InboxView(inbox: machines.inbox, machines: machines, lock: lock)
        }
    }
}

struct LockView: View {
    let lock: AppLock
    var body: some View {
        VStack(spacing: AceTheme.Spacing.lg) {
            Image(systemName: "lock.fill").aceFont(AceTheme.Typography.title, relativeTo: .largeTitle)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            Text("ace is locked").aceFont(AceTheme.Typography.title, relativeTo: .title2).foregroundStyle(AceTheme.Colours.foreground)
            if lock.failed {
                Text("Couldn't verify it's you.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            Button("Unlock") { Task { await lock.unlock() } }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).disabled(lock.authenticating)
                .accessibilityIdentifier("lock.unlock")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AceTheme.Colours.background)
        .task { await lock.unlock() }
    }
}

/// Hides content from the app switcher snapshot.
struct PrivacyCover: View {
    var body: some View {
        AceTheme.Colours.background.ignoresSafeArea()
            .overlay { Image(systemName: "lock.fill").foregroundStyle(AceTheme.Colours.decoration) }
    }
}
