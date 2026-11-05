#if os(iOS)
import SwiftUI
import TallylineCore

/// One filled symbol per issue state, coloured by what it means: attention
/// for work that needs a person, healthy for done, neutral for the rest.
public struct StateGlyph: View {
    public let state: IssueState
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 18

    public init(state: IssueState) { self.state = state }

    public var body: some View {
        Image(systemName: Self.symbol(for: state))
            .font(.system(size: size))
            .foregroundStyle(Self.tint(for: state))
            .contentTransition(.symbolEffect(.replace.downUp))
            .motion(.standard, value: state)
            .accessibilityHidden(true)
    }

    public static func symbol(for state: IssueState) -> String {
        switch state {
        case .triage: "tray.circle.fill"
        case .backlog: "circle.dotted"
        case .todo: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .inReview: "circle.righthalf.filled"
        case .done: "checkmark.circle.fill"
        case .canceled: "xmark.circle.fill"
        case .duplicate: "equal.circle.fill"
        }
    }

    public static func tint(for state: IssueState) -> Color {
        switch state {
        case .triage, .inReview: Theme.attention
        case .inProgress: Theme.accent
        case .done: Theme.healthy
        case .backlog, .todo, .canceled, .duplicate: Theme.neutral
        }
    }
}

#Preview("State glyphs") {
    VStack(alignment: .leading, spacing: 10) {
        ForEach(IssueState.allCases, id: \.self) { state in
            Label { Text(state.displayName) } icon: { StateGlyph(state: state) }
        }
    }
    .padding()
    .background(Theme.canvas)
}

#Preview("State glyphs, dark") {
    VStack(alignment: .leading, spacing: 10) {
        ForEach(IssueState.allCases, id: \.self) { state in
            Label { Text(state.displayName) } icon: { StateGlyph(state: state) }
        }
    }
    .padding()
    .background(Theme.canvas)
    .preferredColorScheme(.dark)
}
#endif
