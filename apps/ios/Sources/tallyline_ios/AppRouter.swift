#if os(iOS)
import Foundation
import Observation
import TallylineCore

/// Where the app should go next, set by pushes, widgets and Shortcuts.
/// HomeView applies it and clears it.
@MainActor @Observable
public final class AppRouter {
    public static let shared = AppRouter()

    var destination: PushDestination?
    /// An issue key to open on top of the current tab.
    var issueKey: String?

    func open(_ destination: PushDestination) {
        self.destination = destination
    }

    func open(issueKey key: String) {
        destination = .myIssues
        issueKey = key
    }
}

/// What Shortcuts can do. The intents themselves live in the app target
/// (AppTarget/Intents.swift) so Xcode extracts their metadata.
@MainActor
public enum TallylineActions {
    public enum Failure: Error, LocalizedError {
        case signedOut
        case noTeam
        case notAKey(String)
        case rejected(String)

        public var errorDescription: String? {
            switch self {
            case .signedOut: "Open Tallyline and sign in first."
            case .noTeam: "Open Tallyline once while online so it can pick a team."
            case .notAKey(let text): "\"\(text)\" is not an issue key. Try something like ENG-12."
            case .rejected(let reason): reason
            }
        }
    }

    public enum Created: Sendable {
        case sent
        case queued
    }

    public static func openMyIssues() {
        AppRouter.shared.open(.myIssues)
    }

    public static func openIssue(_ text: String) throws {
        guard let key = IssueKey.normalize(text) else { throw Failure.notAKey(text) }
        AppRouter.shared.open(issueKey: key)
    }

    /// Creates through the outbox, so it works offline. The team is the one
    /// last used in the app, else the first team.
    public static func createIssue(title: String, description: String?) async throws -> Created {
        let session = SessionModel.shared
        guard case let .signedIn(credential) = session.state else { throw Failure.signedOut }
        let memory = TeamMemory()
        var teamId = memory.teamId
        if let client = session.client, let teams = try? await client.teams(ws: credential.workspaceSlug) {
            teamId = memory.pick(from: teams)?.id
        }
        guard let teamId else { throw Failure.noTeam }
        let draft = IssueCreate(title: title, description: description, teamId: teamId)
        switch await session.offline.submit(.createIssue(draft), workspaceSlug: credential.workspaceSlug) {
        case .sent: return .sent
        case .queued: return .queued
        case .rejected(let reason): throw Failure.rejected(reason)
        }
    }
}
#endif
