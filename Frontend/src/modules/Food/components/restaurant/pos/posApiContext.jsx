import { createContext, useContext } from "react";
import apiClient, { restaurantAPI, adminAPI } from "@food/api";

/**
 * One POS, two callers.
 *
 * The till UI is identical whether the signed-in seller runs it for their own
 * shop or an admin runs it for a store they picked. The only thing that differs
 * is which endpoints the calls land on and how the store is named — the seller
 * is their own store (inferred from auth), the admin names a restaurantId on
 * every call. This context hands the components a single `api` with the same
 * method names in both cases, so nothing below has to know which one it is.
 */

/** Seller mode: the store is the signed-in seller's own, endpoints as-is. */
export function sellerPosApi() {
  return {
    mode: "restaurant",
    restaurantId: null,
    getMenu: (params = {}) => restaurantAPI.getMenu(params),
    getCurrentRestaurant: () => restaurantAPI.getCurrentRestaurant(),
    getOrders: (params = {}) => restaurantAPI.getOrders(params),
    posQuote: restaurantAPI.posQuote,
    posCoupons: restaurantAPI.posCoupons,
    posCreateOrder: restaurantAPI.posCreateOrder,
    posListOrders: restaurantAPI.posListOrders,
    posLastBill: restaurantAPI.posLastBill,
    posGetBill: restaurantAPI.posGetBill,
    getBillDesign: () => restaurantAPI.posBillDesign(),
    posHeartbeat: () => restaurantAPI.posHeartbeat(),
    posMe: () => restaurantAPI.posMe(),
    posRecordPayment: restaurantAPI.posRecordPayment,
    posLookupCustomer: restaurantAPI.posLookupCustomer,
    posSaveCustomer: restaurantAPI.posSaveCustomer,
    posSearchCustomers: restaurantAPI.posSearchCustomers,
    posCustomerSummary: restaurantAPI.posCustomerSummary,
    posListHolds: restaurantAPI.posListHolds,
    posHold: restaurantAPI.posHold,
    posHeldBill: restaurantAPI.posHeldBill,
    posResumeHold: restaurantAPI.posResumeHold,
    posDiscardHold: restaurantAPI.posDiscardHold,
    posCurrentShift: restaurantAPI.posCurrentShift,
    posOpenShift: restaurantAPI.posOpenShift,
    posShiftSummary: restaurantAPI.posShiftSummary,
    posCloseShift: restaurantAPI.posCloseShift,
    posCashMovement: restaurantAPI.posCashMovement,
    posListCreditNotes: restaurantAPI.posListCreditNotes,
    posIssueCreditNote: restaurantAPI.posIssueCreditNote,
    posLookupCreditNote: restaurantAPI.posLookupCreditNote,
    posVoidCreditNote: restaurantAPI.posVoidCreditNote,
    posLoyaltyAccount: restaurantAPI.posLoyaltyAccount,
  };
}

/** Admin mode: every call carries the chosen store's restaurantId. */
export function adminPosApi(restaurantId) {
  const rid = String(restaurantId || "");
  const ctx = { contextModule: "admin" };
  // Body calls fold restaurantId in; GET calls pass it as a query param.
  const post = (path, body = {}) => apiClient.post(`/food/admin/pos${path}`, { restaurantId: rid, ...body }, ctx);
  const del = (path) => apiClient.delete(`/food/admin/pos${path}`, { params: { restaurantId: rid }, ...ctx });
  const get = (path, params = {}) => apiClient.get(`/food/admin/pos${path}`, { params: { restaurantId: rid, ...params }, ...ctx });
  return {
    mode: "admin",
    restaurantId: rid,
    // The till needs the store's sellable products. The admin "menu" endpoint
    // returns an empty structure for most stores, so pull the approved food
    // list and reshape it into the sectioned menu getMenuFromResponse expects,
    // grouped by category so the product grid reads the same as the seller's.
    getMenu: async () => {
      const res = await adminAPI.getFoods({ restaurantId: rid, approvalStatus: "approved", limit: 1000 });
      const foods = res?.data?.data?.foods || res?.data?.foods || [];
      const byCat = {};
      for (const f of foods) {
        const cat = f.category || f.categoryName || f.departmentName || "Products";
        (byCat[cat] = byCat[cat] || []).push(f);
      }
      const sections = Object.entries(byCat).map(([name, items]) => ({ name, items }));
      return { data: { data: { menu: { sections } } } };
    },
    getCurrentRestaurant: () => adminAPI.getRestaurantById(rid),
    getOrders: (params = {}) => adminAPI.getOrders({ restaurantId: rid, ...params }),
    posQuote: (body = {}) => post("/quote", body),
    posCoupons: (body = {}) => post("/coupons", body),
    posCreateOrder: (body = {}) => post("/orders", body),
    posListOrders: (params = {}) => get("/orders", params),
    posLastBill: () => get("/orders/last"),
    posGetBill: (orderId) => get(`/orders/${String(orderId)}`),
    getBillDesign: () => adminAPI.getBillDesign({ restaurantId: rid }),
    posHeartbeat: () => post("/heartbeat"),
    posRecordPayment: (orderId, body = {}) => post(`/orders/${String(orderId)}/payments`, body),
    posLookupCustomer: (phone) => get("/customers/lookup", { phone }),
    posSaveCustomer: (body = {}) => post("/customers", body),
    posSearchCustomers: (q, limit = 10) => get("/customers", { q, limit }),
    posCustomerSummary: (customerId) => get(`/customers/${String(customerId)}/summary`),
    posListHolds: () => get("/holds"),
    posHold: (body = {}) => post("/holds", body),
    posHeldBill: (heldId) => get(`/holds/${String(heldId)}`),
    posResumeHold: (heldId) => post(`/holds/${String(heldId)}/resume`),
    posDiscardHold: (heldId) => del(`/holds/${String(heldId)}`),
    posCurrentShift: () => get("/shift/current"),
    posOpenShift: (body = {}) => post("/shift/open", body),
    posShiftSummary: () => get("/shift/summary"),
    posCloseShift: (body = {}) => post("/shift/close", body),
    posCashMovement: (body = {}) => post("/shift/cash-movement", body),
    posListCreditNotes: (params = {}) => get("/credit-notes", params),
    posIssueCreditNote: (body = {}) => post("/credit-notes", body),
    posLookupCreditNote: (code) => get(`/credit-notes/${encodeURIComponent(String(code || "").trim().toUpperCase())}`),
    posVoidCreditNote: (id) => post(`/credit-notes/${String(id)}/void`),
    posLoyaltyAccount: (userId) => get(`/loyalty/${String(userId)}`),
  };
}

// Default to seller mode so the existing seller POS works with no provider.
const PosApiContext = createContext(sellerPosApi());
export const PosApiProvider = PosApiContext.Provider;
export const usePosApi = () => useContext(PosApiContext);
