import SwiftUI
import WidgetKit

/// The Lock Screen's own widgets: a circle with how many threads need the person, and a line
/// with the sentence and the top thread. Both open ace at that thread.
struct InboxAccessoryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.ace.ios.inbox.accessory", provider: LockProvider()) { entry in
            InboxAccessoryView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Needs you")
        .description("How many threads need you, and the first of them.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}
