import SwiftUI
import WidgetKit

/// Everything ace shows outside the app: a Live Activity for each busy machine, the
/// Home Screen inbox widget, and the Lock Screen's count and top thread.
@main struct AceWidgets: WidgetBundle {
    var body: some Widget {
        MachineActivityWidget()
        InboxWidget()
        InboxAccessoryWidget()
    }
}
