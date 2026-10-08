import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Shield, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import { adminAPI } from "@food/api";

const SUBADMIN_EMAIL_REGEX = /^(?!.*\.\.)([A-Za-z0-9]+[._%+-]?)*[A-Za-z0-9]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}$/;
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const NAME_REGEX = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/;

const hasSuspiciousEmailTld = (emailValue) => {
  const email = String(emailValue || "").trim().toLowerCase();
  const domain = email.split("@")[1] || "";
  const tld = domain.split(".").pop() || "";
  if (!tld) return true;
  if (/^com+$/i.test(tld) && tld !== "com") return true;
  if (/(.)\1{2,}/.test(tld)) return true;
  return false;
};

// Section keys come from the backend catalog in snake_case; show them as words.
const prettySection = (key) =>
  String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const EMPTY_FORM = { name: "", email: "", phone: "", password: "" };

export default function EmployeeList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  // Section-wise permissions for the admin being created, plus the catalog of
  // available sections/actions fetched from the backend (single source of truth).
  const [catalog, setCatalog] = useState({ sections: [], actions: [] });
  const [permissions, setPermissions] = useState({});

  const validateForm = (payload) => {
    const nextErrors = {};
    const name = String(payload?.name || "").trim();
    const email = String(payload?.email || "").trim().toLowerCase();
    const phone = String(payload?.phone || "").trim();
    const password = String(payload?.password || "");

    if (!name) {
      nextErrors.name = "Name is required.";
    } else if (name.length < 2) {
      nextErrors.name = "Name must be at least 2 characters.";
    } else if (!NAME_REGEX.test(name)) {
      nextErrors.name = "Name can contain only letters and spaces.";
    }

    if (!email) {
      nextErrors.email = "Email is required.";
    } else if (!SUBADMIN_EMAIL_REGEX.test(email) || hasSuspiciousEmailTld(email)) {
      nextErrors.email = "Enter a valid email address.";
    }

    if (!phone) {
      nextErrors.phone = "Phone is required.";
    } else if (!INDIAN_MOBILE_REGEX.test(phone)) {
      nextErrors.phone = "Enter a valid 10-digit Indian mobile number.";
    }

    if (!password) {
      nextErrors.password = "Password is required.";
    } else if (password.length < 8) {
      nextErrors.password = "Password must be at least 8 characters.";
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^\w\s]/.test(password)) {
      nextErrors.password = "Use uppercase, lowercase, number, and special character.";
    }

    return nextErrors;
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getSubAdmins({ search });
      setItems(Array.isArray(res?.data?.data?.items) ? res.data.data.items : []);
    } catch (_e) {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Load the permission catalog once for the create matrix.
    (async () => {
      try {
        const res = await adminAPI.getSubAdminPermissionCatalog();
        setCatalog({
          sections: res?.data?.data?.sections || [],
          actions: res?.data?.data?.actions || [],
        });
      } catch (_e) {
        setCatalog({ sections: [], actions: [] });
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((it) => [it.name, it.email, it.phone].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [items, search]);

  // ---- permission matrix helpers (for the new admin being created) ----
  const toggleAction = (sectionKey, action) => {
    setPermissions((prev) => {
      const current = Array.isArray(prev?.[sectionKey]) ? prev[sectionKey] : [];
      const next = current.includes(action)
        ? current.filter((it) => it !== action)
        : [...current, action];
      return { ...prev, [sectionKey]: next };
    });
  };

  const toggleAllSection = (sectionKey, checked) => {
    setPermissions((prev) => ({
      ...prev,
      [sectionKey]: checked ? [...catalog.actions] : [],
    }));
  };

  const grantAll = () => {
    const next = {};
    for (const section of catalog.sections) next[section.key] = [...catalog.actions];
    setPermissions(next);
  };

  const clearAll = () => setPermissions({});

  const selectedSectionCount = useMemo(
    () => Object.values(permissions).filter((acts) => Array.isArray(acts) && acts.length > 0).length,
    [permissions],
  );

  const handleCreate = async (e) => {
    e.preventDefault();
    const normalizedForm = {
      name: String(form.name || "").trim(),
      email: String(form.email || "").trim().toLowerCase(),
      phone: String(form.phone || "").trim(),
      password: String(form.password || ""),
    };
    const validationErrors = validateForm(normalizedForm);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    setSaving(true);
    try {
      await adminAPI.createSubAdmin({ ...normalizedForm, permissions });
      setForm(EMPTY_FORM);
      setPermissions({});
      setErrors({});
      await load();
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (item) => {
    await adminAPI.updateSubAdminStatus(item._id, !item.isActive);
    await load();
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.name || item.email}?`)) return;
    await adminAPI.deleteSubAdmin(item._id);
    await load();
  };

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h1 className="text-2xl font-bold text-slate-900">Sub Admin Management</h1>
        <p className="text-sm text-slate-600 mt-1">
          Create a sub admin with their email &amp; password, and grant section-wise access right here. They can then log in and will
          see only the sections you allow.
        </p>
      </div>

      <form onSubmit={handleCreate} className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <input
              className={`border rounded-lg px-3 py-2 w-full ${errors.name ? "border-red-400" : ""}`}
              placeholder="Name"
              value={form.name}
              onChange={(e) => {
                const cleaned = e.target.value.replace(/[^A-Za-z\s]/g, "").replace(/\s{2,}/g, " ");
                setForm((p) => ({ ...p, name: cleaned }));
                if (errors.name) setErrors((prev) => ({ ...prev, name: "" }));
              }}
            />
            {errors.name ? <p className="mt-1 text-xs text-red-600">{errors.name}</p> : null}
          </div>
          <div>
            <input
              className={`border rounded-lg px-3 py-2 w-full ${errors.email ? "border-red-400" : ""}`}
              placeholder="Email"
              value={form.email}
              onChange={(e) => {
                setForm((p) => ({ ...p, email: e.target.value }));
                if (errors.email) setErrors((prev) => ({ ...prev, email: "" }));
              }}
            />
            {errors.email ? <p className="mt-1 text-xs text-red-600">{errors.email}</p> : null}
          </div>
          <div>
            <input
              className={`border rounded-lg px-3 py-2 w-full ${errors.phone ? "border-red-400" : ""}`}
              placeholder="Phone"
              value={form.phone}
              onChange={(e) => {
                const onlyDigits = e.target.value.replace(/\D/g, "").slice(0, 10);
                setForm((p) => ({ ...p, phone: onlyDigits }));
                if (errors.phone) setErrors((prev) => ({ ...prev, phone: "" }));
              }}
            />
            {errors.phone ? <p className="mt-1 text-xs text-red-600">{errors.phone}</p> : null}
          </div>
          <div>
            <input
              className={`border rounded-lg px-3 py-2 w-full ${errors.password ? "border-red-400" : ""}`}
              placeholder="Password"
              type="password"
              value={form.password}
              onChange={(e) => {
                setForm((p) => ({ ...p, password: e.target.value }));
                if (errors.password) setErrors((prev) => ({ ...prev, password: "" }));
              }}
            />
            {errors.password ? <p className="mt-1 text-xs text-red-600">{errors.password}</p> : null}
          </div>
        </div>

        {/* Section-wise permission matrix */}
        <div className="border border-slate-200 rounded-xl">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Section access</h2>
              <p className="text-xs text-slate-500">
                Tick what this admin can do in each section. {selectedSectionCount} section{selectedSectionCount === 1 ? "" : "s"} granted.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={grantAll} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50">
                Grant all
              </button>
              <button type="button" onClick={clearAll} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50">
                Clear all
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            {catalog.sections.length === 0 ? (
              <p className="text-sm text-slate-500 p-4">Loading sections…</p>
            ) : (
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left p-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">Section</th>
                    <th className="text-center p-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">All</th>
                    {catalog.actions.map((action) => (
                      <th key={action} className="text-center p-3 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                        {action}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catalog.sections.map((section) => {
                    const selected = Array.isArray(permissions?.[section.key]) ? permissions[section.key] : [];
                    const allChecked = catalog.actions.length > 0 && catalog.actions.every((a) => selected.includes(a));
                    return (
                      <tr key={section.key} className="border-b border-slate-100 hover:bg-slate-50/60">
                        <td className="p-3 text-sm font-medium text-slate-800">{prettySection(section.key)}</td>
                        <td className="p-3 text-center">
                          {/* "All" acts as the per-section toggle */}
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#FA0272] cursor-pointer"
                            checked={allChecked}
                            onChange={(e) => toggleAllSection(section.key, e.target.checked)}
                          />
                        </td>
                        {catalog.actions.map((action) => (
                          <td key={action} className="p-3 text-center">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#FA0272] cursor-pointer"
                              checked={selected.includes(action)}
                              onChange={() => toggleAction(section.key, action)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <button disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg disabled:opacity-60">
            <Plus className="w-4 h-4" /> {saving ? "Creating…" : "Create Sub Admin"}
          </button>
          <span className="ml-3 text-xs text-slate-500">You can fine-tune permissions later from the list below.</span>
        </div>
      </form>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="border rounded-lg pl-9 pr-3 py-2 w-full" placeholder="Search sub admins" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="px-3 py-2 border rounded-lg text-sm" onClick={load}>Refresh</button>
        </div>

        {loading ? <div className="text-sm text-slate-500">Loading...</div> : (
          <div className="space-y-3">
            {filtered.map((item) => (
              <div key={item._id} className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">{item.name || "Unnamed"}</p>
                  <p className="text-sm text-slate-600">{item.email} {item.phone ? `• ${item.phone}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Link to={`/admin/store/employee-role?id=${item._id}`} className="inline-flex items-center gap-1 px-3 py-2 border rounded-lg text-sm">
                    <Shield className="w-4 h-4" /> Permissions
                  </Link>
                  <button onClick={() => toggleStatus(item)} className="px-3 py-2 border rounded-lg text-sm inline-flex items-center gap-1">
                    {item.isActive ? <ToggleRight className="w-4 h-4 text-green-600" /> : <ToggleLeft className="w-4 h-4 text-slate-500" />}
                    {item.isActive ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => remove(item)} className="px-3 py-2 border border-red-200 text-red-600 rounded-lg text-sm inline-flex items-center gap-1">
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              </div>
            ))}
            {!filtered.length && <div className="text-sm text-slate-500">No sub admins found.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
