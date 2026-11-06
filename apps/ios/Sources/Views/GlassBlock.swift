import SwiftUI

extension EnvironmentValues {
    /// Inside a glass surface that already draws the material (New thread's card): surfaces draw a
    /// quiet fill instead of their own glass (no glass on glass) and leave the edges to it.
    @Entry var inGlassBlock = false
}
