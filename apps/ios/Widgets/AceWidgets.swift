import SwiftUI
import WidgetKit

/// Everything ace shows outside the app: the one Live Activity for the person's agents, the
/// Home Screen inbox widget, and the Lock Screen's count and top thread.
@main struct AceWidgets: WidgetBundle {
    var body: some Widget {
        AgentsActivityWidget()
        InboxWidget()
        InboxAccessoryWidget()
    }
}
