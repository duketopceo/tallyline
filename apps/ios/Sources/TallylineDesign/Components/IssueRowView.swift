#if os(iOS)
import SwiftUI
import TallylineCore

/// One issue in a list: a state glyph, then the key and title, then one line of
/// metadata. Reads to VoiceOver as a single sentence.
public struct IssueRowView: View {
    public let issue: Issue
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.density) private var density

    public init(issue: Issue) { self.issue = issue }

    public var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StateGlyph(state: issue.state)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: density.rowSpacing) {
                HStack(spacing: 6) {
                    Text(issue.key)
                        .font(.caption.monospaced())
                        .foregroundStyle(Theme.inkSubtle)
                    if issue.creatorType == "agent" { Glint() }
                }
                Text(issue.title)
                    .font(.body)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 6 : density.titleLines)
                HStack(spacing: 8) {
                    PriorityGlyph(priority: issue.priority)
                    if issue.occurrenceCount > 1 {
                        Text("×\(issue.occurrenceCount)")
                            .font(.caption2)
                            .foregroundStyle(Theme.inkSubtle)
                    }
                    Text(issue.updatedAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                        .font(.caption2)
                        .foregroundStyle(Theme.inkSubtle)
                }
            }
        }
        .padding(.vertical, density.verticalPadding)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(IssueSpeech.label(issue))
    }
}

#if DEBUG
private extension Issue {
    static func sample(_ state: IssueState, _ priority: IssuePriority, agent: Bool = false, title: String) -> Issue {
        Issue(
            id: UUID().uuidString, key: "ENG-\(Int.random(in: 10...99))", number: 1, title: title, description: nil,
            state: state, priority: priority, estimate: nil, dueDate: nil, assigneeType: nil, assigneeId: nil,
            delegateType: nil, delegateId: nil, creatorType: agent ? "agent" : "human", creatorId: nil,
            projectId: nil, cycleId: nil, parentId: nil, source: "web",
            occurrenceCount: agent ? 3 : 1, createdAt: Date(), updatedAt: Date().addingTimeInterval(-5400)
        )
    }

    static let samples: [Issue] = [
        .sample(.inReview, .urgent, agent: true, title: "Retry the webhook delivery when the endpoint times out"),
        .sample(.inProgress, .high, title: "Pair a phone from Settings"),
        .sample(.todo, .medium, title: "A much longer title that wraps onto a second line to show the row at its limit"),
        .sample(.done, .none, title: "Ship it"),
    ]
}

#Preview("Rows") {
    List(Issue.samples) { IssueRowView(issue: $0) }
}

#Preview("Rows, dark, compact") {
    List(Issue.samples) { IssueRowView(issue: $0) }
        .environment(\.density, .compact)
        .preferredColorScheme(.dark)
}

#Preview("Rows, largest text") {
    List(Issue.samples) { IssueRowView(issue: $0) }
        .dynamicTypeSize(.accessibility5)
}
#endif
#endif
