import SwiftUI

/// Production root: app lock, then onboarding or the inbox of the selected paired computer.
struct RootView: View {
    @Bindable var machines: MachinesModel
    @Bindable var lock: AppLock
    @Environment(\.scenePhase) private var phase
    @State private var adding = false

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
            if phase == .background { lock.didEnterBackground() }
            if phase == .active { lock.didBecomeActive() }
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
            }
        } else {
            InboxView(model: machines.client)
                .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { MachineBar(machines: machines, adding: $adding) }
                .sheet(isPresented: $adding) {
                    NavigationStack {
                        PairingView(machines: machines) { adding = false }
                            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { adding = false } } }
                    }
                }
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
                .buttonStyle(.borderedProminent).disabled(lock.authenticating)
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
