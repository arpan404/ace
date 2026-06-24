import SwiftUI

@main
struct AceDesktopApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .frame(minWidth: 980, minHeight: 640)
        }
    }
}

struct RootView: View {
    var body: some View {
        Text("Ace Desktop")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
