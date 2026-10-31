#if os(iOS)
import UIKit

/// Haptics, used sparingly (DESIGN.md): only when something finished or
/// failed out of view, never for taps the screen already answers.
@MainActor
enum Haptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
#endif
