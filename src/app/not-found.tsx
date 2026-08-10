import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-2xl font-semibold text-text-tertiary mb-4 select-none data-mono">404</p>
        <h1 className="text-xl font-semibold text-text-primary mb-2">Page not found</h1>
        <p className="text-text-secondary text-md mb-6">This page doesn&apos;t exist or has been moved.</p>
        <Link
          href="/jobs"
          className="inline-flex items-center gap-2 h-7 px-3 bg-accent hover:bg-accent-hover text-text-inverse text-md font-medium rounded transition-colors"
        >
          Back to jobs
        </Link>
      </div>
    </div>
  );
}
