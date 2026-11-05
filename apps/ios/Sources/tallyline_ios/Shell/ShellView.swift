#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// The tabs. Settings is not one: it opens from the profile button.
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case issues, review, search
    var id: String { rawValue }

    var title: String {
        switch self {
        case .issues: "Issues"
        case .review: "Review"
        case .search: "Search"
        }
    }

    var symbol: String {
        switch self {
        case .issues: "list.bullet"
        case .review: "checkmark.circle"
        case .search: "magnifyingglass"
        }
    }

    /// Command-number shortcut. Search has none of its own (Command-F is the
    /// system's).
    var shortcut: KeyEquivalent? {
        switch self {
        case .issues: "1"
        case .review: "2"
        case .search: nil
        }
    }

    init(_ destination: PushDestination) {
        switch destination {
        case .review: self = .review
        case .myIssues, .now, .projects, .roadmap, .settings: self = .issues
        }
    }
}

/// Which tab is up and whether Settings is showing. Shared with every tab's
/// toolbar through the environment.
@MainActor @Observable
final class ShellState {
    var tab: AppTab = .issues
    var showSettings = false
}

/// Signed-in shell. One `TabView` serves iPhone and iPad: a bottom bar on
/// compact widths, a top bar with a sidebar toggle on regular ones. The search
/// tab sits at the trailing edge.
struct ShellView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var shell = ShellState()
    @State private var reviewCount = 0

    var body: some View {
        TabView(selection: $shell.tab) {
            Tab(AppTab.issues.title, systemImage: AppTab.issues.symbol, value: AppTab.issues) {
                IssueListView(session: session, credential: credential, state: nil)
            }
            Tab(AppTab.review.title, systemImage: AppTab.review.symbol, value: AppTab.review) {
                ReviewQueueView(session: session, credential: credential, count: $reviewCount)
            }
            .badge(reviewCount)
            Tab(AppTab.search.title, systemImage: AppTab.search.symbol, value: AppTab.search, role: .search) {
                SearchView(session: session, credential: credential)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .modifier(MinimizeTabBarOnScroll())
        .tint(Theme.accent)
        .environment(shell)
        .background { shortcuts }
        .task { await session.loadMe() }
        .onChange(of: AppRouter.shared.destination, initial: true) { _, destination in
            guard let destination else { return }
            if destination == .settings {
                shell.showSettings = true
            } else {
                shell.tab = AppTab(destination)
            }
            AppRouter.shared.destination = nil
        }
        .sheet(isPresented: $shell.showSettings) {
            SettingsView(session: session, credential: credential)
        }
        .sheet(item: Binding(
            get: { AppRouter.shared.issueKey.map { OpenIssueKey(id: $0) } },
            set: { AppRouter.shared.issueKey = $0?.id }
        )) { item in
            NavigationStack {
                IssueLoaderView(session: session, credential: credential, key: item.id)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { AppRouter.shared.issueKey = nil }
                        }
                    }
            }
        }
    }

    /// Invisible buttons that carry the hardware-keyboard shortcuts, so the
    /// Command-key overlay on iPad lists them.
    private var shortcuts: some View {
        ZStack {
            ForEach(AppTab.allCases) { tab in
                if let key = tab.shortcut {
                    Button(tab.title) { shell.tab = tab }
                        .keyboardShortcut(key, modifiers: .command)
                }
            }
            Button("Settings") { shell.showSettings = true }
                .keyboardShortcut(",", modifiers: .command)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

/// iOS 26 shrinks the tab bar while scrolling; earlier systems keep it.
private struct MinimizeTabBarOnScroll: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}

/// The profile button every tab carries. Opens Settings.
struct ProfileToolbarItem: ToolbarContent {
    var session: SessionModel
    @Environment(ShellState.self) private var shell

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                shell.showSettings = true
            } label: {
                Text(Initials.from(session.me?.name))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(minWidth: 28, minHeight: 28)
                    .background(Theme.surface3, in: Circle())
            }
            .accessibilityLabel("Settings")
        }
    }
}
#endif
