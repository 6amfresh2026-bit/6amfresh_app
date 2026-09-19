import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Loader2, Settings2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { adminAPI, uploadAPI } from "@food/api"

/**
 * Product "Create New" / edit — a replica of the reference ERP's product form.
 *
 * Two cards in the reference's order and with its labels:
 *   General Details — Item Code/Barcode (Auto Generate), Product Type, Product
 *     Name, Print Name; Category, Sub Category, Brand, Sub Brand, Unit (+ Add
 *     Unit, max 3); HSN Code, Purchase Tax (Inclusive), Sales Tax (Inclusive),
 *     Cess %, Manage Multiple Batch; Short Description; Description; Nutrition
 *     (+ Add Nutrition); Net Weight Unit, Additional Info.
 *   Pricing Details — Purchase Price, Landing Cost, MRP, Selling Discount,
 *     Selling Price, Selling Margin; Retailer and Wholesaler discount / price /
 *     margin; Online Price, Minimum Quantity, Opening Qty, Net Weight.
 * then Add Variant, then Cancel / Clear / Save / Save & Create New.
 *
 * One field the reference does not have: Store. Every product here belongs to a
 * seller, and the API refuses a product without one, so it sits first.
 */

/**
 * Sentinel value for the dropdown row that opens the Add Category modal.
 *
 * Deliberately not something that could ever be an ObjectId, so it cannot
 * collide with a real category and get saved as one.
 */
const ADD_NEW = "__add_new__"

const TAX_RATES = [0, 5, 12, 18, 28]
const PRODUCT_TYPES = ["Finished", "Raw Material", "Semi Finished", "Service", "Consumable"]

const blank = () => ({
  restaurantId: "",
  itemCode: "",
  autoCode: true,
  productType: "Finished",
  name: "",
  printName: "",
  categoryId: "",
  subCategoryId: "",
  brandId: "",
  subBrandId: "",
  unitId: "",
  additionalUnitIds: [],
  hsnCode: "",
  purchaseTaxRate: "",
  purchaseTaxInclusive: false,
  gstRate: "",
  salesTaxInclusive: false,
  cessEnabled: false,
  cessRate: "",
  manageMultipleBatch: false,
  expiryDate: "",
  shortDescription: "",
  description: "",
  nutrition: [],
  netWeightUnitId: "",
  additionalInfo: "",
  image: "",
  foodType: "Veg",
  purchasePrice: "",
  landingCost: "",
  mrp: "",
  sellingDiscount: "",
  price: "",
  sellingMargin: "",
  retailerDiscount: "",
  retailerPrice: "",
  retailerMargin: "",
  wholesalerDiscount: "",
  wholesalerPrice: "",
  wholesalerMargin: "",
  onlinePrice: "",
  minimumQuantity: "",
  stockQty: "",
  netWeight: "",
  variants: [],
})

const n = (v) => (v === "" || v === null || v === undefined ? null : Number(v))
const s = (v) => (v === null || v === undefined ? "" : String(v))
const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "")

/**
 * A field's caption, reserving two lines whether or not it needs them.
 *
 * Grid cells in a row are the same height but their contents start at the top,
 * so a caption that wraps -- "Item Code/Barcode" alongside its (Auto Generate)
 * checkbox does, at four columns -- pushed that one input a line below its
 * neighbours. Fixing the height and sitting the caption on its floor lines the
 * inputs up across the row regardless of how long any one caption is.
 */
const Label = ({ children, required, right }) => (
  <div className="mb-1 flex items-end justify-between gap-2 sm:min-h-10">
    <span className="text-sm font-semibold leading-5 text-neutral-800">
      {children}
      {required && <span className="text-rose-500">*</span>}
    </span>
    {right}
  </div>
)
const inp = "h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-sky-500 disabled:bg-neutral-100"
const Err = ({ children }) => (children ? <p className="mt-1 text-xs text-rose-600">{children}</p> : null)

/**
 * The validation errors, handed to F without threading them through 33 call
 * sites.
 *
 * F has to live out here. Defined inside the form it was a fresh component
 * type on every render, so React tore down and rebuilt each field's subtree
 * rather than updating it -- and a remounted <input> is not the focused one,
 * which is why a product name could only ever be typed one letter at a time.
 */
const FieldErrorsContext = createContext({})

const F = ({ k, label, required, children, right }) => {
  const errors = useContext(FieldErrorsContext)
  return (
    <div>
      <Label required={required} right={right}>{label}</Label>
      {children}
      <Err>{errors[k]}</Err>
    </div>
  )
}

/** ₹-prefixed numeric input, as the reference draws discount and margin fields. */
const Rupee = ({ value, onChange, disabled }) => (
  <div className="flex h-10 overflow-hidden rounded border border-neutral-300 bg-white focus-within:border-sky-500">
    <span className="grid w-9 shrink-0 place-items-center border-r border-neutral-300 bg-neutral-100 text-sm text-neutral-600">₹</span>
    <input type="number" step="any" value={value} onChange={onChange} disabled={disabled} className="w-full px-3 text-sm outline-none disabled:bg-neutral-100" />
  </div>
)

export default function ProductForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const editing = Boolean(id)

  const [form, setForm] = useState(blank)
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(editing)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)

  const [stores, setStores] = useState([])
  const [categories, setCategories] = useState([])
  const [brands, setBrands] = useState([])
  const [units, setUnits] = useState([])

  const set = (k) => (e) => {
    const v = e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  // Its own function because the Add Category modal has to pull the list again
  // to show what it just created.
  const loadCategories = useCallback(async () => {
    const c = await adminAPI.getCategories({ limit: 1000 })
    const cats = c?.data?.data?.categories || c?.data?.data || []
    const list = Array.isArray(cats) ? cats : []
    setCategories(list)
    return list
  }, [])

  // ── lookups ──
  useEffect(() => {
    ;(async () => {
      try {
        const [r, , b, u] = await Promise.all([
          adminAPI.getRestaurants({ limit: 1000 }),
          loadCategories(),
          adminAPI.getBrands({ limit: 200, isActive: "true" }),
          adminAPI.getUnits({ limit: 200, isActive: "true" }),
        ])
        setStores(r?.data?.data?.restaurants || r?.data?.restaurants || [])
        setBrands(b?.data?.data?.brands || [])
        setUnits(u?.data?.data?.units || [])
      } catch {
        toast.error("Could not load dropdown data")
      }
    })()
  }, [loadCategories])

  // ── auto item code (create only) ──
  useEffect(() => {
    if (editing || !form.autoCode) return
    ;(async () => {
      try {
        const res = await adminAPI.getNextItemCode()
        setForm((f) => ({ ...f, itemCode: res?.data?.data?.itemCode || "" }))
      } catch {
        /* the API assigns one on save anyway */
      }
    })()
  }, [editing, form.autoCode])

  // ── load for edit ──
  useEffect(() => {
    if (!editing) return
    ;(async () => {
      try {
        const res = await adminAPI.getFoodById(id)
        const f = res?.data?.data?.food
        if (!f) throw new Error("not found")
        setForm({
          ...blank(),
          autoCode: false,
          restaurantId: s(f.restaurantId),
          itemCode: f.itemCode || "",
          productType: f.productType || "Finished",
          name: f.name || "",
          printName: f.printName || "",
          categoryId: s(f.categoryId),
          subCategoryId: s(f.subCategoryId),
          brandId: s(f.brandId),
          subBrandId: s(f.subBrandId),
          unitId: s(f.unitId),
          additionalUnitIds: (f.additionalUnitIds || []).map(String),
          hsnCode: f.hsnCode || "",
          purchaseTaxRate: s(f.purchaseTaxRate),
          purchaseTaxInclusive: !!f.purchaseTaxInclusive,
          gstRate: s(f.gstRate),
          salesTaxInclusive: !!f.salesTaxInclusive,
          cessEnabled: !!f.cessEnabled,
          cessRate: s(f.cessRate),
          manageMultipleBatch: !!f.manageMultipleBatch,
          // Sliced off the ISO string rather than round-tripped through Date:
          // a date saved as UTC midnight reads back as the previous day in IST,
          // which would quietly move every expiry a day earlier on every edit.
          expiryDate: f.expiryDate ? String(f.expiryDate).slice(0, 10) : "",
          shortDescription: f.shortDescription || "",
          description: f.description || "",
          nutrition: (f.nutrition || []).map((x) => ({ name: x.name || "", value: x.value || "", unit: x.unit || "" })),
          netWeightUnitId: s(f.netWeightUnitId),
          additionalInfo: f.additionalInfo || "",
          image: f.image || "",
          foodType: f.foodType || "Veg",
          purchasePrice: s(f.purchasePrice),
          landingCost: s(f.landingCost),
          mrp: s(f.mrp),
          sellingDiscount: s(f.sellingDiscount),
          price: s(f.price),
          sellingMargin: s(f.sellingMargin),
          retailerDiscount: s(f.retailerDiscount),
          retailerPrice: s(f.retailerPrice),
          retailerMargin: s(f.retailerMargin),
          wholesalerDiscount: s(f.wholesalerDiscount),
          wholesalerPrice: s(f.wholesalerPrice),
          wholesalerMargin: s(f.wholesalerMargin),
          onlinePrice: s(f.onlinePrice),
          minimumQuantity: s(f.minimumQuantity),
          stockQty: s(f.stockQty),
          netWeight: s(f.netWeight),
          variants: (f.variants || []).map((v) => ({ name: v.name || "", price: s(v.price), otherPrice: s(v.otherPrice) })),
        })
      } catch {
        toast.error("Product not found")
        navigate("/admin/store/products")
      } finally {
        setLoading(false)
      }
    })()
  }, [editing, id, navigate])

  // ── derived option lists ──
  const catId = (c) => String(c._id || c.id)
  const catParent = (c) => (c.parentId ? String(c.parentId) : c.parent ? String(c.parent) : "")
  const topCategories = useMemo(() => categories.filter((c) => !catParent(c)), [categories])
  const subCategories = useMemo(() => categories.filter((c) => catParent(c) === form.categoryId), [categories, form.categoryId])
  const topBrands = useMemo(() => brands.filter((b) => !b.parentId), [brands])
  const subBrands = useMemo(() => brands.filter((b) => b.parentId === form.brandId), [brands, form.brandId])
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units])

  // ── add a category without leaving the product ──
  const [catModal, setCatModal] = useState(null)
  const [savingCat, setSavingCat] = useState(false)

  const openCatModal = () =>
    setCatModal({ name: "", parentId: "", foodTypeScope: "Both", error: "" })

  const saveNewCategory = async () => {
    const name = catModal.name.trim()
    if (!name) {
      setCatModal((m) => ({ ...m, error: "Enter a category name" }))
      return
    }
    setSavingCat(true)
    try {
      const res = await adminAPI.createCategory({
        name,
        parentId: catModal.parentId || undefined,
        foodTypeScope: catModal.foodTypeScope,
        zoneId: "global",
        isActive: true,
      })
      const created = res?.data?.data?.category || res?.data?.data
      const list = await loadCategories()
      // Prefer the id the API returned; fall back to finding it by name, since
      // an admin who cannot see their new category in the dropdown has no idea
      // whether it saved.
      const match =
        (created && (created._id || created.id) && String(created._id || created.id)) ||
        (list.find((c) => c.name === name) ? catId(list.find((c) => c.name === name)) : "")

      if (match) {
        setForm((f) =>
          catModal.parentId
            ? { ...f, categoryId: catModal.parentId, subCategoryId: match }
            : { ...f, categoryId: match, subCategoryId: "" },
        )
        setErrors((er) => ({ ...er, categoryId: undefined }))
      }
      toast.success("Category created")
      setCatModal(null)
    } catch (error) {
      setCatModal((m) => ({
        ...m,
        error: error?.response?.data?.message || "Could not create the category",
      }))
    } finally {
      setSavingCat(false)
    }
  }

  // ── pricing arithmetic, the way the reference fills the greyed fields ──
  const recompute = useCallback((f) => {
    const mrp = n(f.mrp)
    const pp = n(f.purchasePrice)
    const tier = (disc, priceKey, marginKey) => {
      const d = n(disc)
      const price = mrp !== null && d !== null ? mrp - d : n(f[priceKey])
      const margin = price !== null && pp !== null ? price - pp : n(f[marginKey])
      return { [priceKey]: price === null ? f[priceKey] : fmt(price), [marginKey]: margin === null ? f[marginKey] : fmt(margin) }
    }
    return {
      ...f,
      ...tier(f.sellingDiscount, "price", "sellingMargin"),
      ...tier(f.retailerDiscount, "retailerPrice", "retailerMargin"),
      ...tier(f.wholesalerDiscount, "wholesalerPrice", "wholesalerMargin"),
    }
  }, [])
  const setPricing = (k) => (e) => {
    const v = e.target.value
    setForm((f) => recompute({ ...f, [k]: v }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  // ── units (max 3) ──
  const addUnitSlot = () => {
    if (form.additionalUnitIds.length >= 2) return toast.error("Max. 3 Units can be added")
    setForm((f) => ({ ...f, additionalUnitIds: [...f.additionalUnitIds, ""] }))
  }
  const setExtraUnit = (i, v) => setForm((f) => ({ ...f, additionalUnitIds: f.additionalUnitIds.map((x, j) => (j === i ? v : x)) }))
  const removeExtraUnit = (i) => setForm((f) => ({ ...f, additionalUnitIds: f.additionalUnitIds.filter((_, j) => j !== i) }))

  // ── nutrition ──
  const addNutrition = () => setForm((f) => ({ ...f, nutrition: [...f.nutrition, { name: "", value: "", unit: "" }] }))
  const setNutrition = (i, k, v) => setForm((f) => ({ ...f, nutrition: f.nutrition.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }))
  const removeNutrition = (i) => setForm((f) => ({ ...f, nutrition: f.nutrition.filter((_, j) => j !== i) }))

  // ── variants ──
  const addVariant = () => setForm((f) => ({ ...f, variants: [...f.variants, { name: "", price: "", otherPrice: "" }] }))
  const setVariant = (i, k, v) => setForm((f) => ({ ...f, variants: f.variants.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }))
  const removeVariant = (i) => setForm((f) => ({ ...f, variants: f.variants.filter((_, j) => j !== i) }))

  const onImage = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await uploadAPI.uploadMedia(file, { folder: "switcheats/admin/products" })
      const url = res?.data?.data?.url || res?.data?.url || ""
      if (!url) throw new Error("no url")
      setForm((f) => ({ ...f, image: url }))
    } catch {
      toast.error("Image upload failed")
    } finally {
      setUploading(false)
    }
  }

  // ── validation: the reference's red "Select …" under required fields ──
  const validate = () => {
    const er = {}
    if (!form.restaurantId) er.restaurantId = "Select Store"
    if (!form.name.trim()) er.name = "Enter Product Name"
    if (!form.printName.trim()) er.printName = "Enter Print Name"
    if (!form.categoryId) er.categoryId = "Select Category"
    if (!form.brandId) er.brandId = "Select Brand"
    if (!form.unitId) er.unitId = "Select Unit"
    if (form.purchaseTaxRate === "") er.purchaseTaxRate = "Select Purchase Tax"
    if (form.gstRate === "") er.gstRate = "Select Sales Tax"
    ;["purchasePrice", "landingCost", "mrp", "sellingDiscount", "price", "sellingMargin", "retailerDiscount", "retailerPrice", "retailerMargin", "wholesalerDiscount", "wholesalerPrice", "wholesalerMargin", "onlinePrice", "minimumQuantity"].forEach((k) => {
      if (form[k] === "" || !Number.isFinite(Number(form[k]))) er[k] = "Required"
    })
    if (n(form.mrp) !== null && n(form.price) !== null && n(form.price) > n(form.mrp)) er.price = "Cannot exceed MRP"
    setErrors(er)
    if (Object.keys(er).length) toast.error("Please fill the required fields")
    return Object.keys(er).length === 0
  }

  const payload = () => ({
    restaurantId: form.restaurantId,
    itemCode: form.autoCode && !editing ? undefined : form.itemCode.trim() || undefined,
    productType: form.productType,
    name: form.name.trim(),
    printName: form.printName.trim(),
    categoryId: form.categoryId,
    subCategoryId: form.subCategoryId || null,
    brandId: form.brandId || null,
    subBrandId: form.subBrandId || null,
    brand: brands.find((b) => b.id === form.brandId)?.name || "",
    unitId: form.unitId || null,
    additionalUnitIds: form.additionalUnitIds.filter(Boolean),
    hsnCode: form.hsnCode.trim(),
    purchaseTaxRate: n(form.purchaseTaxRate),
    purchaseTaxInclusive: form.purchaseTaxInclusive,
    gstRate: n(form.gstRate),
    salesTaxInclusive: form.salesTaxInclusive,
    cessEnabled: form.cessEnabled,
    cessRate: form.cessEnabled ? n(form.cessRate) : null,
    manageMultipleBatch: form.manageMultipleBatch,
    // In batch mode each intake carries its own expiry and the picker reads
    // those, so a product-level date would be a second answer to the same
    // question — and the one nobody acts on. Cleared rather than kept hidden.
    expiryDate: form.manageMultipleBatch ? null : form.expiryDate || null,
    shortDescription: form.shortDescription.trim(),
    description: form.description.trim(),
    nutrition: form.nutrition.filter((x) => x.name.trim()),
    netWeightUnitId: form.netWeightUnitId || null,
    additionalInfo: form.additionalInfo.trim(),
    image: form.image,
    foodType: form.foodType,
    purchasePrice: n(form.purchasePrice),
    landingCost: n(form.landingCost),
    mrp: n(form.mrp),
    sellingDiscount: n(form.sellingDiscount),
    price: n(form.price),
    sellingMargin: n(form.sellingMargin),
    retailerDiscount: n(form.retailerDiscount),
    retailerPrice: n(form.retailerPrice),
    retailerMargin: n(form.retailerMargin),
    wholesalerDiscount: n(form.wholesalerDiscount),
    wholesalerPrice: n(form.wholesalerPrice),
    wholesalerMargin: n(form.wholesalerMargin),
    onlinePrice: n(form.onlinePrice),
    minimumQuantity: n(form.minimumQuantity),
    stockQty: n(form.stockQty),
    netWeight: n(form.netWeight),
    variants: form.variants.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), price: n(v.price) ?? 0, otherPrice: n(v.otherPrice) ?? 0 })),
  })

  const save = async (createAnother) => {
    if (!validate()) return
    setSaving(true)
    try {
      if (editing) {
        await adminAPI.updateFood(id, payload())
        toast.success("Product updated")
      } else {
        await adminAPI.createFood(payload())
        toast.success("Product created")
      }
      if (createAnother) {
        setForm({ ...blank(), restaurantId: form.restaurantId })
        setErrors({})
        window.scrollTo({ top: 0 })
      } else {
        navigate("/admin/store/products")
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="grid min-h-[50vh] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-neutral-400" /></div>
  }

  return (
    <FieldErrorsContext.Provider value={errors}>
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2 text-lg">
        <span className="font-semibold text-neutral-900">Product</span>
        <span className="text-neutral-300">|</span>
        <span className="text-neutral-400">⌂</span>
        <span className="text-neutral-300">›</span>
        <span className="text-neutral-600">{editing ? "Edit" : "Create New"}</span>
      </div>

      {/* ───────────── General Details ───────────── */}
      <section className="mb-4 rounded-md border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3">
          <Settings2 className="h-4 w-4 text-neutral-400" />
          <h2 className="font-medium text-sky-600">General Details</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
          <F k="restaurantId" label="Store" required>
            <select value={form.restaurantId} onChange={set("restaurantId")} disabled={editing} className={inp}>
              <option value="">Select Store</option>
              {stores.map((r) => <option key={r._id || r.id} value={r._id || r.id}>{r.restaurantName || r.name}</option>)}
            </select>
          </F>
          <F
            k="itemCode"
            label="Item Code/Barcode"
            required
            right={!editing && (
              <label className="flex items-center gap-1.5 text-xs italic text-neutral-500">
                (Auto Generate)
                <input type="checkbox" checked={form.autoCode} onChange={set("autoCode")} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" />
              </label>
            )}
          >
            <input value={form.itemCode} onChange={set("itemCode")} disabled={form.autoCode && !editing} className={inp} />
          </F>
          <F k="productType" label="Product Type" required>
            <select value={form.productType} onChange={set("productType")} className={inp}>
              {PRODUCT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </F>
          <F k="name" label="Product Name" required>
            <input value={form.name} onChange={(e) => { set("name")(e); if (!form.printName) setForm((f) => ({ ...f, name: e.target.value, printName: e.target.value })) }} placeholder="Product Name" className={inp} />
          </F>
          <F k="printName" label="Print Name" required>
            <input value={form.printName} onChange={set("printName")} placeholder="Print Name" className={inp} />
          </F>

          <F k="categoryId" label="Category" required>
            <select
              value={form.categoryId}
              onChange={(e) => {
                // The last entry is an action, not a category. Returning
                // without touching form leaves the select showing whatever was
                // picked before, because its value is still form.categoryId.
                if (e.target.value === ADD_NEW) { openCatModal(); return }
                set("categoryId")(e)
                setForm((f) => ({ ...f, categoryId: e.target.value, subCategoryId: "" }))
              }}
              className={inp}
            >
              <option value="">Select Category</option>
              {topCategories.map((c) => <option key={catId(c)} value={catId(c)}>{c.name}</option>)}
              <option value={ADD_NEW}>+ Add New Category</option>
            </select>
          </F>
          <F k="subCategoryId" label="Sub Category">
            <select value={form.subCategoryId} onChange={set("subCategoryId")} className={inp} disabled={!subCategories.length}>
              <option value="">Select Sub Category</option>
              {subCategories.map((c) => <option key={catId(c)} value={catId(c)}>{c.name}</option>)}
            </select>
          </F>
          <F k="brandId" label="Brand" required>
            <select value={form.brandId} onChange={(e) => setForm((f) => ({ ...f, brandId: e.target.value, subBrandId: "" }))} className={inp}>
              <option value="">Select Brand</option>
              {topBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </F>
          <F k="subBrandId" label="Sub Brand">
            <select value={form.subBrandId} onChange={set("subBrandId")} className={inp} disabled={!subBrands.length}>
              <option value="">Select Sub Brand</option>
              {subBrands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </F>

          <div className="md:col-span-2">
            <Label required right={<button type="button" onClick={addUnitSlot} className="text-sm font-medium text-sky-600 underline">+ Add Unit</button>}>Unit</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              <select value={form.unitId} onChange={set("unitId")} className={inp}>
                <option value="">Select Unit</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.shortName})</option>)}
              </select>
              {form.additionalUnitIds.map((v, i) => (
                <div key={i} className="flex gap-1">
                  <select value={v} onChange={(e) => setExtraUnit(i, e.target.value)} className={inp}>
                    <option value="">Select Unit</option>
                    {units.filter((u) => u.id !== form.unitId).map((u) => <option key={u.id} value={u.id}>{u.name}{u.conversionLabel ? ` · ${u.conversionLabel}` : ""}</option>)}
                  </select>
                  <button type="button" onClick={() => removeExtraUnit(i)} className="grid w-9 shrink-0 place-items-center rounded border border-neutral-300 text-rose-500"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
            <p className="mt-1 text-xs text-sky-600">Max. 3 Units can be added</p>
            <Err>{errors.unitId}</Err>
          </div>
          <F k="foodType" label="Food Type">
            <select value={form.foodType} onChange={set("foodType")} className={inp}>
              <option value="Veg">Veg</option>
              <option value="Non-Veg">Non-Veg</option>
            </select>
          </F>
          <F k="image" label="Image">
            <div className="flex items-center gap-2">
              {form.image && <img src={form.image} alt="" className="h-10 w-10 rounded border object-cover" />}
              <input type="file" accept="image/*" onChange={onImage} disabled={uploading} className="text-xs" />
              {uploading && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
            </div>
          </F>

          <F k="hsnCode" label="HSN Code">
            <input value={form.hsnCode} onChange={set("hsnCode")} placeholder="HSN Code" className={inp} />
          </F>
          <F k="purchaseTaxRate" label="Purchase Tax" required right={
            <label className="flex items-center gap-1.5 text-xs italic text-neutral-500">(Inclusive)<input type="checkbox" checked={form.purchaseTaxInclusive} onChange={set("purchaseTaxInclusive")} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" /></label>
          }>
            <select value={form.purchaseTaxRate} onChange={set("purchaseTaxRate")} className={inp}>
              <option value="">Select Purchase Tax</option>
              {TAX_RATES.map((t) => <option key={t} value={t}>GST {t}%</option>)}
            </select>
          </F>
          <F k="gstRate" label="Sales Tax" required right={
            <label className="flex items-center gap-1.5 text-xs italic text-neutral-500">(Inclusive)<input type="checkbox" checked={form.salesTaxInclusive} onChange={set("salesTaxInclusive")} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" /></label>
          }>
            <select value={form.gstRate} onChange={set("gstRate")} className={inp}>
              <option value="">Select Sales Tax</option>
              {TAX_RATES.map((t) => <option key={t} value={t}>GST {t}%</option>)}
            </select>
          </F>
          <div className="grid grid-cols-2 gap-4">
            <F k="cessRate" label="Cess %" right={<input type="checkbox" checked={form.cessEnabled} onChange={set("cessEnabled")} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" />}>
              <input type="number" step="any" value={form.cessRate} onChange={set("cessRate")} disabled={!form.cessEnabled} className={inp} />
            </F>
            <label className="mt-7 flex items-center gap-2 text-sm font-semibold text-neutral-800">
              <input type="checkbox" checked={form.manageMultipleBatch} onChange={set("manageMultipleBatch")} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" />
              Manage Multiple Batch
            </label>
          </div>

          <F k="expiryDate" label="Expiry Date">
            <input
              type="date"
              data-testid="product-expiry"
              value={form.manageMultipleBatch ? "" : form.expiryDate}
              onChange={set("expiryDate")}
              disabled={form.manageMultipleBatch}
              className={`${inp} disabled:bg-neutral-100 disabled:text-neutral-400`}
            />
            <p className="mt-1 text-xs text-neutral-500">
              {form.manageMultipleBatch
                ? "Each batch carries its own expiry — set it when the stock is received."
                : "Leave blank for anything that does not expire."}
            </p>
          </F>

          <div className="md:col-span-2 xl:col-span-4">
            <Label>Short Description</Label>
            <textarea value={form.shortDescription} onChange={set("shortDescription")} rows={2} placeholder="Enter Short Description" className="w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-sky-500" />
          </div>
          <div className="md:col-span-2 xl:col-span-4">
            <Label>Description</Label>
            <textarea value={form.description} onChange={set("description")} rows={5} className="w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-sky-500" />
          </div>

          <div className="md:col-span-2 xl:col-span-4">
            <div className="flex items-center justify-between rounded bg-neutral-100 px-3 py-2">
              <span className="text-sm font-semibold text-neutral-800">Nutrition</span>
              <button type="button" onClick={addNutrition} className="text-sm font-medium text-sky-600 underline">+ Add Nutrition</button>
            </div>
            {form.nutrition.length > 0 && (
              <div className="mt-2 space-y-2">
                {form.nutrition.map((x, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                    <input value={x.name} onChange={(e) => setNutrition(i, "name", e.target.value)} placeholder="Name (e.g. Fat)" className={inp} />
                    <input value={x.value} onChange={(e) => setNutrition(i, "value", e.target.value)} placeholder="Value" className={inp} />
                    <input value={x.unit} onChange={(e) => setNutrition(i, "unit", e.target.value)} placeholder="Unit (g / kcal)" className={inp} />
                    <button type="button" onClick={() => removeNutrition(i)} className="grid w-10 place-items-center rounded border border-neutral-300 text-rose-500"><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <F k="netWeightUnitId" label="Net Weight Unit">
            <select value={form.netWeightUnitId} onChange={set("netWeightUnitId")} className={inp}>
              <option value="">Select Unit</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.shortName})</option>)}
            </select>
          </F>
          <F k="additionalInfo" label="Additional Info">
            <input value={form.additionalInfo} onChange={set("additionalInfo")} placeholder="Additional Info" className={inp} />
          </F>
        </div>
      </section>

      {/* ───────────── Pricing Details ───────────── */}
      <section className="mb-4 rounded-md border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3">
          <Settings2 className="h-4 w-4 text-neutral-400" />
          <h2 className="font-medium text-sky-600">Pricing Details</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <F k="purchasePrice" label="Purchase Price" required><input type="number" step="any" value={form.purchasePrice} onChange={setPricing("purchasePrice")} placeholder="0.0" className={inp} /></F>
          <F k="landingCost" label="Landing Cost" required><input type="number" step="any" value={form.landingCost} onChange={set("landingCost")} placeholder="0" className={inp} /></F>
          <F k="mrp" label="MRP" required><input type="number" step="any" value={form.mrp} onChange={setPricing("mrp")} placeholder="0.0" className={inp} /></F>
          <F k="sellingDiscount" label="Selling Discount" required><Rupee value={form.sellingDiscount} onChange={setPricing("sellingDiscount")} /></F>
          <F k="price" label="Selling Price" required><input type="number" step="any" value={form.price} onChange={setPricing("price")} placeholder="0.0" className={inp} /></F>
          <F k="sellingMargin" label="Selling Margin" required><Rupee value={form.sellingMargin} onChange={set("sellingMargin")} /></F>

          <F k="retailerDiscount" label="Retailer Discount" required><Rupee value={form.retailerDiscount} onChange={setPricing("retailerDiscount")} /></F>
          <F k="retailerPrice" label="Retailer Price" required><input type="number" step="any" value={form.retailerPrice} onChange={setPricing("retailerPrice")} placeholder="0.0" className={inp} /></F>
          <F k="retailerMargin" label="Retailer Margin" required><Rupee value={form.retailerMargin} onChange={set("retailerMargin")} /></F>
          <F k="wholesalerDiscount" label="Wholesaler Discount" required><Rupee value={form.wholesalerDiscount} onChange={setPricing("wholesalerDiscount")} /></F>
          <F k="wholesalerPrice" label="Wholesaler Price" required><input type="number" step="any" value={form.wholesalerPrice} onChange={setPricing("wholesalerPrice")} placeholder="0.0" className={inp} /></F>
          <F k="wholesalerMargin" label="Wholesaler Margin" required><Rupee value={form.wholesalerMargin} onChange={set("wholesalerMargin")} /></F>

          <F k="onlinePrice" label="Online Price" required><input type="number" step="any" value={form.onlinePrice} onChange={set("onlinePrice")} placeholder="0" className={inp} /></F>
          <F k="minimumQuantity" label="Minimum Quantity" required><input type="number" step="any" value={form.minimumQuantity} onChange={set("minimumQuantity")} placeholder="0" className={inp} /></F>
          <F k="stockQty" label="Opening Qty"><input type="number" step="any" value={form.stockQty} onChange={set("stockQty")} placeholder="0" className={inp} /></F>
          <F k="netWeight" label="Net Weight"><input type="number" step="any" value={form.netWeight} onChange={set("netWeight")} placeholder="0" className={inp} /></F>
        </div>
      </section>

      {/* ───────────── Variants ───────────── */}
      <section className="mb-4 rounded-md border border-neutral-200 bg-white p-4 text-center shadow-sm">
        <button type="button" onClick={addVariant} className="rounded bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600">Add Variant</button>
        <p className="mt-2 text-sm text-neutral-800">Add Variants If This Product Comes In Multiple Versions, Like Different Sizes or Colors.</p>
        {form.variants.length > 0 && (
          <div className="mt-4 space-y-2 text-left">
            {form.variants.map((v, i) => (
              <div key={i} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2">
                <input value={v.name} onChange={(e) => setVariant(i, "name", e.target.value)} placeholder="Variant name (e.g. 500 g)" className={inp} />
                <input type="number" step="any" value={v.price} onChange={(e) => setVariant(i, "price", e.target.value)} placeholder="Price" className={inp} />
                <input type="number" step="any" value={v.otherPrice} onChange={(e) => setVariant(i, "otherPrice", e.target.value)} placeholder="Compare-at" className={inp} />
                <button type="button" onClick={() => removeVariant(i)} className="grid w-10 place-items-center rounded border border-neutral-300 text-rose-500"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ───────────── Footer ───────────── */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-between border-t border-neutral-200 bg-neutral-100 px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="flex gap-2">
          <button type="button" onClick={() => navigate("/admin/store/products")} className="rounded bg-neutral-200 px-5 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-300">Cancel</button>
          <button type="button" onClick={() => { setForm({ ...blank(), restaurantId: form.restaurantId }); setErrors({}) }} className="rounded bg-neutral-200 px-5 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-300">Clear</button>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={saving} onClick={() => save(false)} className="inline-flex items-center gap-2 rounded bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
          {!editing && (
            <button type="button" disabled={saving} onClick={() => save(true)} className="rounded bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
              Save &amp; Create New
            </button>
          )}
        </div>
      </div>

      {catModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={() => !savingCat && setCatModal(null)}>
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-base font-semibold text-neutral-900">Add Category</h3>

            <div className="space-y-3">
              <div>
                <Label required>Category Name</Label>
                <input
                  autoFocus
                  value={catModal.name}
                  onChange={(e) => setCatModal((m) => ({ ...m, name: e.target.value, error: "" }))}
                  onKeyDown={(e) => { if (e.key === "Enter") saveNewCategory() }}
                  placeholder="e.g. Dairy"
                  className={inp}
                />
              </div>

              <div>
                <Label>Parent Category</Label>
                <select value={catModal.parentId} onChange={(e) => setCatModal((m) => ({ ...m, parentId: e.target.value }))} className={inp}>
                  <option value="">None — this is a top-level category</option>
                  {topCategories.map((c) => <option key={catId(c)} value={catId(c)}>{c.name}</option>)}
                </select>
                {/* Picking a parent is what makes this a sub-category, so the
                    same modal covers both dropdowns above. */}
                <p className="mt-1 text-xs text-neutral-500">Pick one to create a sub-category instead.</p>
              </div>

              <div>
                <Label>Food Type</Label>
                <select value={catModal.foodTypeScope} onChange={(e) => setCatModal((m) => ({ ...m, foodTypeScope: e.target.value }))} className={inp}>
                  <option value="Both">Both</option>
                  <option value="Veg">Veg</option>
                  <option value="Non-Veg">Non-Veg</option>
                </select>
              </div>

              <Err>{catModal.error}</Err>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setCatModal(null)} disabled={savingCat} className="rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-700 disabled:opacity-60">
                Cancel
              </button>
              <button type="button" onClick={saveNewCategory} disabled={savingCat} className="inline-flex items-center gap-2 rounded bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
                {savingCat && <Loader2 className="h-4 w-4 animate-spin" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </FieldErrorsContext.Provider>
  )
}
