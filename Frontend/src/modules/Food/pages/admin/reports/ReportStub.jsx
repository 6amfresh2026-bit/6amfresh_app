import { Hammer } from "lucide-react"

/**
 * Placeholder for a Reports & Operations page that is on the roadmap but not
 * built yet. Keeps the sidebar entry navigable (no 404) and names the report
 * so the section reads as intended. Pass the report name via `title`.
 */
export default function ReportStub({ title = "Report", description }) {
  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {description || "Seller and operations reporting."}
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <Hammer className="h-7 w-7" />
        </div>
        <h2 className="text-lg font-semibold text-slate-800">Coming soon</h2>
        <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
          “{title}” is on the roadmap. The menu entry is in place — the report itself
          will be built next. Tell us the columns and filters you need and we’ll wire it up.
        </p>
      </div>
    </div>
  )
}
