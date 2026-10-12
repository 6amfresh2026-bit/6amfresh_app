import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { Plus, Trash2, ClipboardList, Loader2, X, ImagePlus, Star } from "lucide-react"
import { adminAPI, uploadAPI } from "@food/api"

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"]
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const QUESTION_TYPES = [
  { value: "text", label: "Text answer" },
  { value: "single-choice", label: "Single choice" },
  { value: "multiple-choice", label: "Multiple choice" },
  { value: "rating", label: "Rating" },
]

const emptyQuestion = () => ({ text: "", type: "text", optionsText: "", image: "" })

export default function SurveyManagement() {
  const [surveys, setSurveys] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [statusUpdatingId, setStatusUpdatingId] = useState(null)

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [questions, setQuestions] = useState([emptyQuestion()])
  const [uploadingIndex, setUploadingIndex] = useState(null)

  const loadSurveys = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAPI.getSurveys()
      setSurveys(res?.data?.data?.surveys || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load surveys")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSurveys()
  }, [loadSurveys])

  const resetForm = () => {
    setTitle("")
    setDescription("")
    setQuestions([emptyQuestion()])
  }

  const addQuestion = () => setQuestions((prev) => [...prev, emptyQuestion()])

  const removeQuestion = (index) =>
    setQuestions((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))

  const updateQuestion = (index, patch) =>
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)))

  const needsOptions = (type) => type === "single-choice" || type === "multiple-choice"

  // Upload a question's image to shared media storage and keep the returned URL.
  const handleQuestionImage = async (index, file) => {
    if (!file) return
    if (!IMAGE_TYPES.includes(file.type)) {
      toast.error("Invalid file type. Use PNG, JPG, JPEG or WEBP.")
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image must be 5MB or smaller.")
      return
    }
    setUploadingIndex(index)
    try {
      const res = await uploadAPI.uploadMedia(file, { folder: "food/surveys" })
      const url = res?.data?.data?.url
      if (!url) throw new Error("No URL returned")
      updateQuestion(index, { image: url })
      toast.success("Image uploaded")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to upload image")
    } finally {
      setUploadingIndex(null)
    }
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!title.trim()) {
      toast.error("Survey title is required")
      return
    }
    const cleanedQuestions = questions
      .filter((q) => q.text.trim())
      .map((q) => ({
        text: q.text.trim(),
        type: q.type,
        options: needsOptions(q.type)
          ? q.optionsText.split(",").map((o) => o.trim()).filter(Boolean)
          : [],
        image: q.image || "",
      }))
    if (!cleanedQuestions.length) {
      toast.error("At least one question is required")
      return
    }
    const badOptions = cleanedQuestions.find((q) => needsOptions(q.type) && q.options.length < 2)
    if (badOptions) {
      toast.error("Choice questions need at least 2 comma-separated options")
      return
    }

    setCreating(true)
    try {
      await adminAPI.createSurvey({ title: title.trim(), description: description.trim(), questions: cleanedQuestions })
      toast.success("Survey created successfully")
      resetForm()
      setShowForm(false)
      loadSurveys()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to create survey")
    } finally {
      setCreating(false)
    }
  }

  const handleToggleStatus = async (survey) => {
    const nextStatus = survey.status === "active" ? "inactive" : "active"
    setStatusUpdatingId(survey._id)
    try {
      await adminAPI.updateSurveyStatus(survey._id, nextStatus)
      toast.success(
        nextStatus === "active"
          ? "Survey activated — it will now show once to new users"
          : "Survey deactivated"
      )
      loadSurveys()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update survey status")
    } finally {
      setStatusUpdatingId(null)
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <ClipboardList className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Survey</h1>
              <p className="text-sm text-slate-500">
                Shown once to new users the first time they open the app. Only one survey can be active at a time.
              </p>
            </div>
          </div>

          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-2 transition-all shadow-md"
          >
            {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showForm ? "Cancel" : "Create Survey"}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} className="mt-6 border-t border-slate-200 pt-6 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Welcome survey"
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Description (optional)
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Shown under the title in the popup"
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Questions ({questions.length})
                </label>
                <button
                  type="button"
                  onClick={addQuestion}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Add question
                </button>
              </div>

              <div className="space-y-3">
                {questions.map((q, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                    <div className="flex items-start gap-2">
                      <span className="mt-2.5 text-xs font-bold text-slate-400 w-5">{i + 1}.</span>
                      <div className="flex-1 space-y-2">
                        <input
                          type="text"
                          value={q.text}
                          onChange={(e) => updateQuestion(i, { text: e.target.value })}
                          placeholder="Question text"
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={q.type}
                            onChange={(e) => updateQuestion(i, { type: e.target.value })}
                            className="px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {QUESTION_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                          {needsOptions(q.type) && (
                            <input
                              type="text"
                              value={q.optionsText}
                              onChange={(e) => updateQuestion(i, { optionsText: e.target.value })}
                              placeholder="Options, comma separated e.g. Yes, No, Maybe"
                              className="flex-1 min-w-[220px] px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          )}
                        </div>

                        {/* Optional image for this question */}
                        <div className="flex items-center gap-3">
                          {q.image ? (
                            <div className="relative">
                              <img src={q.image} alt="Question" className="h-16 w-16 rounded-lg object-cover border border-slate-200" />
                              <button
                                type="button"
                                onClick={() => updateQuestion(i, { image: "" })}
                                title="Remove image"
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center shadow"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ) : (
                            <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-dashed border-slate-300 text-slate-600 bg-white hover:bg-slate-50 cursor-pointer">
                              {uploadingIndex === i ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <ImagePlus className="w-4 h-4" />
                              )}
                              {uploadingIndex === i ? "Uploading…" : "Add image (optional)"}
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/jpg,image/webp"
                                className="hidden"
                                disabled={uploadingIndex === i}
                                onChange={(e) => {
                                  const file = e.target.files?.[0]
                                  e.target.value = ""
                                  handleQuestionImage(i, file)
                                }}
                              />
                            </label>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeQuestion(i)}
                        disabled={questions.length === 1}
                        className="p-2 rounded text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Remove question"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Live preview — how the survey popup will look to users, rendered
                per question type as the admin builds it. */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Preview — how users will see it
              </div>
              <div className="mx-auto w-full max-w-sm select-none rounded-2xl border border-slate-200 bg-white p-5 shadow-lg">
                <h3 className="text-lg font-bold text-slate-900">{title.trim() || "Survey title"}</h3>
                {description.trim() && <p className="mt-1 text-sm text-slate-500">{description.trim()}</p>}

                <div className="mt-4 space-y-4">
                  {questions.filter((q) => q.text.trim()).length === 0 ? (
                    <p className="text-sm text-slate-400">Add a question to see the preview.</p>
                  ) : (
                    questions
                      .filter((q) => q.text.trim())
                      .map((q, i) => {
                        const opts = q.optionsText.split(",").map((o) => o.trim()).filter(Boolean)
                        const shownOpts = opts.length ? opts : ["Option 1", "Option 2"]
                        return (
                          <div key={i} className="space-y-2">
                            <p className="text-sm font-medium text-slate-800">{i + 1}. {q.text.trim()}</p>
                            {q.image && (
                              <img src={q.image} alt="" className="max-h-40 w-full rounded-lg object-cover" />
                            )}
                            {q.type === "text" && (
                              <input
                                disabled
                                placeholder="Type your answer…"
                                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400"
                              />
                            )}
                            {q.type === "single-choice" && (
                              <div className="space-y-1.5">
                                {shownOpts.map((o, oi) => (
                                  <div key={oi} className="flex items-center gap-2 text-sm text-slate-700">
                                    <span className="inline-block h-4 w-4 shrink-0 rounded-full border-2 border-slate-300" />
                                    {o}
                                  </div>
                                ))}
                              </div>
                            )}
                            {q.type === "multiple-choice" && (
                              <div className="space-y-1.5">
                                {shownOpts.map((o, oi) => (
                                  <div key={oi} className="flex items-center gap-2 text-sm text-slate-700">
                                    <span className="inline-block h-4 w-4 shrink-0 rounded border-2 border-slate-300" />
                                    {o}
                                  </div>
                                ))}
                              </div>
                            )}
                            {q.type === "rating" && (
                              <div className="flex items-center gap-1">
                                {[1, 2, 3, 4, 5].map((n) => (
                                  <Star key={n} className="h-6 w-6 text-amber-300" />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })
                  )}
                </div>

                <button disabled className="mt-5 w-full rounded-lg bg-blue-600/60 py-2.5 text-sm font-semibold text-white">
                  Submit
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creating}
                className="px-5 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2"
              >
                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                {creating ? "Creating…" : "Create Survey"}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Survey ID</th>
                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Title</th>
                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Questions</th>
                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Created</th>
                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-16 text-center text-slate-500">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading surveys…
                  </td>
                </tr>
              ) : surveys.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-16 text-center">
                    <p className="text-lg font-semibold text-slate-700 mb-1">No surveys yet</p>
                    <p className="text-sm text-slate-500">Create one to show it to new users the first time they open the app.</p>
                  </td>
                </tr>
              ) : (
                surveys.map((survey) => (
                  <tr key={survey._id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        {survey.surveyId || "—"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-slate-800">{survey.title}</div>
                      {survey.description && (
                        <div className="text-xs text-slate-500 mt-0.5">{survey.description}</div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                      {survey.questions?.length || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                      {survey.createdAt ? new Date(survey.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <button
                        onClick={() => handleToggleStatus(survey)}
                        disabled={statusUpdatingId === survey._id}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-60 ${
                          survey.status === "active" ? "bg-blue-600" : "bg-slate-300"
                        }`}
                        title={survey.status === "active" ? "Active — click to deactivate" : "Inactive — click to activate"}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            survey.status === "active" ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
