import Link from "next/link";

export default function IssueNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
      <p className="text-[15px] font-medium text-ink">This issue is gone</p>
      <p className="mt-1 max-w-sm text-[13px] text-ink-subtle">
        It was deleted, or this link is stale. Its history isn't recoverable.
      </p>
      <Link
        href="/issues"
        className="mt-4 h-7 rounded-sm bg-accent px-3 text-[13px] font-medium leading-7 text-on-accent hover:bg-accent-hover"
      >
        Back to issues
      </Link>
    </div>
  );
}
