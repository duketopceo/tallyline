#if os(iOS)
import SwiftUI
import TallylineCore

/// Optimistic edits shared by list swipes, menus and the detail screen. Every
/// write goes through the outbox; a refusal puts the old row back.
@MainActor
struct IssueActions {
    let session: SessionModel
    let credential: DeviceCredential

    /// Shows the change at once, sends it, and undoes it if the server refuses.
    @discardableResult
    func apply(_ patch: IssuePatch, to issue: Issue) async -> SubmitOutcome {
        session.offline.applyLocally(issue.applying(patch))
        let outcome = await session.offline.submit(
            .updateIssue(key: issue.key, patch: patch),
            workspaceSlug: credential.workspaceSlug
        )
        if case .rejected = outcome { session.offline.applyLocally(issue) }
        return outcome
    }

    func move(_ issue: Issue, to state: IssueState) async -> SubmitOutcome {
        await apply(IssuePatch(state: state), to: issue)
    }

    func assignToMe(_ issue: Issue) async -> SubmitOutcome {
        await apply(IssuePatch(assigneeType: "human", assigneeId: credential.userId), to: issue)
    }
}
#endif
