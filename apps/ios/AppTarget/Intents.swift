#if os(iOS)
import AppIntents
import tallyline_ios

// App Shortcuts for Tallyline (S6-U5). The work happens in TallylineActions;
// these types only describe it to Shortcuts and Spotlight.

struct CreateIssueIntent: AppIntent {
    static var title: LocalizedStringResource { "Create issue" }
    static var description: IntentDescription {
        IntentDescription("Adds an issue to Tallyline. Offline, it waits on the phone and sends when you're back.")
    }

    @Parameter(title: "Title")
    var issueTitle: String

    @Parameter(title: "Description")
    var details: String?

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let title = issueTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw $issueTitle.needsValueError("What should the issue say?") }
        switch try await TallylineActions.createIssue(title: title, description: details) {
        case .sent: return .result(dialog: "Created the issue.")
        case .queued: return .result(dialog: "Saved. It sends when you're back online.")
        }
    }
}

struct OpenIssuesIntent: AppIntent {
    static var title: LocalizedStringResource { "Open issues" }
    static var description: IntentDescription { IntentDescription("Opens the Issues list in Tallyline.") }
    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        TallylineActions.openMyIssues()
        return .result()
    }
}

struct OpenIssueIntent: AppIntent {
    static var title: LocalizedStringResource { "Open issue" }
    static var description: IntentDescription { IntentDescription("Opens an issue by its key, like ENG-12.") }
    static var openAppWhenRun: Bool { true }

    @Parameter(title: "Issue key")
    var key: String

    @MainActor
    func perform() async throws -> some IntentResult {
        try TallylineActions.openIssue(key)
        return .result()
    }
}

struct TallylineShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CreateIssueIntent(),
            phrases: ["Create an issue in \(.applicationName)", "New \(.applicationName) issue"],
            shortTitle: "Create issue",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: OpenIssuesIntent(),
            phrases: ["Open issues in \(.applicationName)", "Show my \(.applicationName) issues"],
            shortTitle: "Issues",
            systemImageName: "list.bullet"
        )
        AppShortcut(
            intent: OpenIssueIntent(),
            phrases: ["Open an issue in \(.applicationName)"],
            shortTitle: "Open issue",
            systemImageName: "arrow.up.forward.app"
        )
    }
}
#endif
