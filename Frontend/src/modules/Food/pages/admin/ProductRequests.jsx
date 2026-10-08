import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, Trash2, ChevronLeft, ChevronRight, PackagePlus, Loader2 } from "lucide-react";
import { adminAPI } from "@food/api";
import { toast } from "sonner";

const STATUS_OPTIONS = ["pending", "reviewed", "approved", "rejected", "fulfilled"];

const STATUS_STYLES = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  reviewed: "bg-sky-50 text-sky-700 border-sky-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  fulfilled: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

const PAGE_SIZE = 20;

const formatDateTime = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

export default function ProductRequests() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [updatingId, setUpdatingId] = useState(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getProductRequests({
        page,
        limit: PAGE_SIZE,
        ...(status !== "all" && { status }),
        ...(search && { search }),
      });
      const data = res?.data?.data || {};
      setItems(Array.isArray(data.requests) ? data.requests : []);
      setTotalPages(data.pagination?.pages || 1);
      setTotal(data.pagination?.total || 0);
    } catch (_e) {
      setItems([]);
      setTotalPages(1);
      setTotal(0);
      toast.error("Failed to load product requests");
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleStatusChange = async (item, nextStatus) => {
    if (nextStatus === item.status) return;
    setUpdatingId(item._id);
    try {
      const res = await adminAPI.updateProductRequest(item._id, { status: nextStatus });
      if (res?.data?.success) {
        setItems((prev) => prev.map((it) => (it._id === item._id ? { ...it, status: nextStatus } : it)));
        toast.success(`Marked as ${nextStatus}`);
      } else {
        toast.error(res?.data?.message || "Failed to update");
      }
    } catch (_e) {
      toast.error("Failed to update status");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete the request for "${item.productName}"?`)) return;
    try {
      const res = await adminAPI.deleteProductRequest(item._id);
      if (res?.data?.success) {
        toast.success("Request deleted");
        fetchRequests();
      } else {
        toast.error(res?.data?.message || "Failed to delete");
      }
    } catch (_e) {
      toast.error("Failed to delete request");
    }
  };

  const showingText = useMemo(() => {
    if (loading) return "Loading…";
    if (total === 0) return "No requests";
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = (page - 1) * PAGE_SIZE + items.length;
    return `Showing ${from}-${to} of ${total}`;
  }, [loading, total, page, items.length]);

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-5">
        {/* Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#FA0272]/10 flex items-center justify-center">
            <PackagePlus className="w-5 h-5 text-[#FA0272]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Product Requests</h1>
            <p className="text-sm text-slate-600">Products customers asked for but the catalog does not carry yet.</p>
          </div>
        </div>

        {/* Toolbar */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="border border-slate-300 rounded-lg pl-9 pr-3 py-2 w-full text-sm focus:outline-none focus:ring-2 focus:ring-[#FA0272]/30"
              placeholder="Search by product, brand, customer…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white capitalize"
          >
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s} className="capitalize">
                {s}
              </option>
            ))}
          </select>
          <button onClick={handleSearch} className="px-4 py-2 rounded-lg bg-[#FA0272] text-white text-sm font-medium">
            Search
          </button>
          <button
            onClick={fetchRequests}
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm inline-flex items-center gap-1.5 hover:bg-slate-50"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* List */}
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-3">{showingText}</div>

          {loading ? (
            <div className="py-16 flex items-center justify-center text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-slate-500">No product requests found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left p-3 text-[11px] font-bold text-slate-600 uppercase tracking-wide">Product</th>
                    <th className="text-left p-3 text-[11px] font-bold text-slate-600 uppercase tracking-wide">Customer</th>
                    <th className="text-left p-3 text-[11px] font-bold text-slate-600 uppercase tracking-wide">Details</th>
                    <th className="text-left p-3 text-[11px] font-bold text-slate-600 uppercase tracking-wide">Requested</th>
                    <th className="text-left p-3 text-[11px] font-bold text-slate-600 uppercase tracking-wide">Status</th>
                    <th className="text-center p-3 text-[11px] font-bold text-slate-600 uppercase tracking-wide">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => {
                    const customerName = item.customerName || item.userId?.name || "—";
                    const customerPhone = item.customerPhone || item.userId?.phone || "";
                    return (
                      <tr key={item._id} className="hover:bg-slate-50/60 align-top">
                        <td className="p-3">
                          <p className="text-sm font-semibold text-slate-900">{item.productName}</p>
                          {item.quantity ? <p className="text-xs text-slate-500">Qty: {item.quantity}</p> : null}
                        </td>
                        <td className="p-3">
                          <p className="text-sm text-slate-800">{customerName}</p>
                          {customerPhone ? <p className="text-xs text-slate-500">{customerPhone}</p> : null}
                        </td>
                        <td className="p-3 max-w-[260px]">
                          {item.brand ? <p className="text-xs text-slate-600"><span className="text-slate-400">Brand:</span> {item.brand}</p> : null}
                          {item.category ? <p className="text-xs text-slate-600"><span className="text-slate-400">Category:</span> {item.category}</p> : null}
                          {item.note ? <p className="text-xs text-slate-600 mt-0.5">{item.note}</p> : null}
                          {!item.brand && !item.category && !item.note ? <span className="text-xs text-slate-400">—</span> : null}
                        </td>
                        <td className="p-3 text-xs text-slate-600 whitespace-nowrap">{formatDateTime(item.createdAt)}</td>
                        <td className="p-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border capitalize ${
                              STATUS_STYLES[item.status] || "bg-slate-100 text-slate-600 border-slate-200"
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center justify-center gap-2">
                            <select
                              value={item.status}
                              disabled={updatingId === item._id}
                              onChange={(e) => handleStatusChange(item, e.target.value)}
                              className="border border-slate-300 rounded-md px-2 py-1 text-xs bg-white capitalize disabled:opacity-50"
                            >
                              {STATUS_OPTIONS.map((s) => (
                                <option key={s} value={s} className="capitalize">
                                  {s}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => handleDelete(item)}
                              title="Delete request"
                              className="p-1.5 rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {!loading && totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4">
              <span className="text-xs text-slate-500">Page {page} of {totalPages}</span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm disabled:opacity-50 hover:bg-slate-50"
                >
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm disabled:opacity-50 hover:bg-slate-50"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
