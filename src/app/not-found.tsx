import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-7xl font-bold text-slate-200 mb-4 select-none">404</p>
        <h1 className="text-xl font-semibold text-slate-800 mb-2">Page not found</h1>
        <p className="text-slate-500 text-sm mb-6">This page doesn&apos;t exist or has been moved.</p>
        <Link
          href="/jobs"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Back to jobs
        </Link>
      </div>
    </div>
  );
}
