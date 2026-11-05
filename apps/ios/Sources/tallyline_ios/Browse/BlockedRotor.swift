#if os(iOS)
import SwiftUI
import TallylineCore

/// A VoiceOver rotor over blocked issues. Not added at all when none are
/// blocked, so the rotor menu never offers an empty "Blocked".
struct BlockedRotor: ViewModifier {
    /// One entry per blocked issue: the id the list row carries and its spoken label.
    let entries: [(id: String, label: String)]

    @ViewBuilder
    func body(content: Content) -> some View {
        if entries.isEmpty {
            content
        } else {
            content.accessibilityRotor("Blocked") {
                ForEach(entries, id: \.id) { entry in
                    AccessibilityRotorEntry(entry.label, id: entry.id)
                }
            }
        }
    }
}

extension BlockedRotor {
    init(issues: [Issue]) {
        self.init(entries: BlockedIssues.filter(issues).map { ($0.id, IssueSpeech.label($0)) })
    }
}
#endif
