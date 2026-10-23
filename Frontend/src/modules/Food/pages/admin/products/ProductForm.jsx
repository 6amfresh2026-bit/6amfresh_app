import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ImagePlus, Loader2, Trash2 } from "lucide-react"
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

const STEPS = ["Category", "Product details", "Pricing & stock", "Availability", "Subscription", "Review"]

// A tile with no uploaded image falls back to a picture that fits the name.
const EMOJI = [[/fresh|fruit|veg/i, "🥬"], [/dairy|milk|egg/i, "🥛"], [/staple|grain|rice|atta|dal/i, "🌾"], [/spice/i, "🌶️"], [/beverage|drink|juice/i, "☕"], [/snack|biscuit|cookie/i, "🍪"], [/house|clean/i, "🧴"], [/personal|care|beauty/i, "💄"], [/meat|chicken|fish/i, "🍗"], [/bake|bread/i, "🥖"]]
const categoryEmoji = (name) => (EMOJI.find(([re]) => re.test(String(name || ""))) || [null, "📦"])[1]

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
  images: [],
  foodType: "Veg",
  isAvailable: true,
  isRecommended: false,
  subscriptionEnabled: false,
  preparationTime: "",
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
  lowStockThreshold: "",
  criticalStockThreshold: "",
  outOfStockThreshold: "",
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

  const [step, setStep] = useState(0)
  const [counts, setCounts] = useState({})
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
          images: Array.isArray(f.images) && f.images.length ? f.images : (f.image ? [f.image] : []),
          foodType: f.foodType || "Veg",
          isAvailable: f.isAvailable !== false,
          isRecommended: !!f.isRecommended,
          subscriptionEnabled: !!f.subscriptionEnabled,
          preparationTime: f.preparationTime || "",
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
          lowStockThreshold: s(f.lowStockThreshold),
          criticalStockThreshold: s(f.criticalStockThreshold),
          outOfStockThreshold: s(f.outOfStockThreshold),
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

  // ── pick a category tile ──
  const pickCategory = (id) => {
    setForm((f) => ({ ...f, categoryId: id, subCategoryId: "" }))
    setErrors((er) => ({ ...er, categoryId: undefined }))
  }

  // Product counts for the tiles; refreshed for the chosen store.
  useEffect(() => {
    let cancelled = false
    adminAPI
      .getFoodCategoryCounts(form.restaurantId ? { restaurantId: form.restaurantId } : {})
      .then((res) => { if (!cancelled) setCounts(res?.data?.data?.counts || {}) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [form.restaurantId])

  // ── add a category (or a sub category of the chosen one) without leaving the product ──
  const [newCat, setNewCat] = useState({ name: "", error: "" })
  const [savingCat, setSavingCat] = useState(false)

  const addCategoryInline = async (asSub) => {
    const name = newCat.name.trim()
    if (!name) { setNewCat((m) => ({ ...m, error: "Enter a category name" })); return }
    setSavingCat(true)
    try {
      const res = await adminAPI.createCategory({
        name,
        parentId: asSub ? form.categoryId : undefined,
        foodTypeScope: "Both",
        zoneId: "global",
        isActive: true,
      })
      const created = res?.data?.data?.category || res?.data?.data
      const list = await loadCategories()
      // Prefer the id the API returned; fall back to finding it by name, since an admin
      // who cannot see their new category has no idea whether it saved.
      const found = list.find((c) => c.name === name)
      const match = (created && (created._id || created.id) && String(created._id || created.id)) || (found ? catId(found) : "")
      if (match) {
        setForm((f) => (asSub ? { ...f, subCategoryId: match } : { ...f, categoryId: match, subCategoryId: "" }))
        setErrors((er) => ({ ...er, categoryId: undefined }))
      }
      toast.success(asSub ? "Sub category created" : "Category created")
      setNewCat({ name: "", error: "" })
    } catch (error) {
      setNewCat((m) => ({ ...m, error: error?.response?.data?.message || "Could not create the category" }))
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

  const onImages = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = "" // lets the same file be re-picked later
    if (!files.length) return
    setUploading(true)
    try {
      const uploaded = []
      for (const file of files) {
        const res = await uploadAPI.uploadMedia(file, { folder: "switcheats/admin/products" })
        const url = res?.data?.data?.url || res?.data?.url || ""
        if (url) uploaded.push(url)
      }
      if (!uploaded.length) throw new Error("no url")
      setForm((f) => ({ ...f, images: [...f.images, ...uploaded] }))
      if (uploaded.length < files.length) toast.error(`${files.length - uploaded.length} image(s) failed to upload`)
    } catch {
      toast.error("Image upload failed")
    } finally {
      setUploading(false)
    }
  }
  const removeImage = (i) => setForm((f) => ({ ...f, images: f.images.filter((_, j) => j !== i) }))
  // The first image is the primary everywhere else in the app reads a single
  // `image` from, so "make primary" is just moving it to the front.
  const makePrimary = (i) => setForm((f) => ({ ...f, images: [f.images[i], ...f.images.filter((_, j) => j !== i)] }))

  // ── validation: red "Select …" under required fields, one step at a time ──
  const PRICE_KEYS = ["purchasePrice", "landingCost", "mrp", "sellingDiscount", "price", "sellingMargin", "retailerDiscount", "retailerPrice", "retailerMargin", "wholesalerDiscount", "wholesalerPrice", "wholesalerMargin", "onlinePrice", "minimumQuantity"]
  const stepErrors = (i) => {
    const er = {}
    if (i === 0) {
      if (!form.restaurantId) er.restaurantId = "Select Store"
      if (!form.categoryId) er.categoryId = "Select Category"
    }
    if (i === 1) {
      if (!form.name.trim()) er.name = "Enter Product Name"
      if (!form.printName.trim()) er.printName = "Enter Print Name"
      if (!form.brandId) er.brandId = "Select Brand"
      if (!form.unitId) er.unitId = "Select Unit"
      if (form.purchaseTaxRate === "") er.purchaseTaxRate = "Select Purchase Tax"
      if (form.gstRate === "") er.gstRate = "Select Sales Tax"
    }
    if (i === 2) {
      PRICE_KEYS.forEach((k) => {
        if (form[k] === "" || !Number.isFinite(Number(form[k]))) er[k] = "Required"
      })
      if (n(form.mrp) !== null && n(form.price) !== null && n(form.price) > n(form.mrp)) er.price = "Cannot exceed MRP"
    }
    return er
  }

  /** Every step, for Save. Jumps to the first step that has something to fix. */
  const validate = () => {
    for (let i = 0; i < 3; i++) {
      const er = stepErrors(i)
      if (Object.keys(er).length) {
        setErrors(er)
        setStep(i)
        toast.error("Please fill the required fields")
        return false
      }
    }
    setErrors({})
    return true
  }

  const next = () => {
    const er = stepErrors(step)
    setErrors(er)
    if (Object.keys(er).length) { toast.error("Please fill the required fields"); return }
    setStep((x) => Math.min(STEPS.length - 1, x + 1))
  }

  // A step tab: going back is free; going forward needs every step on the way to be complete.
  const goTo = (target) => {
    if (target <= step) { setStep(target); return }
    for (let i = step; i < Math.min(target, 3); i++) {
      const er = stepErrors(i)
      if (Object.keys(er).length) { setErrors(er); setStep(i); toast.error("Please fill the required fields"); return }
    }
    setStep(target)
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
    image: form.images[0] || "",
    images: form.images,
    foodType: form.foodType,
    isAvailable: form.isAvailable,
    isRecommended: form.isRecommended,
    subscriptionEnabled: form.subscriptionEnabled,
    preparationTime: form.preparationTime.trim(),
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
    lowStockThreshold: n(form.lowStockThreshold),
    criticalStockThreshold: n(form.criticalStockThreshold),
    outOfStockThreshold: n(form.outOfStockThreshold),
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
        setStep(0)
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

  const chosenCategory = topCategories.find((c) => catId(c) === form.categoryId)
  const chosenSub = subCategories.find((c) => catId(c) === form.subCategoryId)
  const storeName = (stores.find((r) => String(r._id || r.id) === form.restaurantId) || {}).restaurantName || ""
  const brandName = brands.find((b) => b.id === form.brandId)?.name || ""
  const unitName = unitById.get(form.unitId)?.name || ""
  const last = step === STEPS.length - 1

  const card = "rounded-xl border border-emerald-100 bg-white p-4 shadow-sm sm:p-5"
  const toggleRow = (checked, onChange, title, hint) => (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-neutral-200 bg-white p-4 hover:bg-neutral-50">
      <span>
        <span className="block text-sm font-semibold text-neutral-900">{title}</span>
        <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-1 h-5 w-5 shrink-0 accent-[color:var(--module-theme,#10b981)]" />
    </label>
  )
  const row = (label, value) => (
    <div className="flex items-start justify-between gap-3 border-b border-neutral-100 py-2 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="text-right font-medium text-neutral-900">{value === "" || value === null || value === undefined ? "—" : value}</span>
    </div>
  )

  return (
    <FieldErrorsContext.Provider value={errors}>
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-neutral-900">{editing ? "Edit product" : "Add a new product"}</h1>
        <button type="button" onClick={() => navigate("/admin/store/products")} className="rounded-full border border-emerald-300 px-5 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">Cancel</button>
      </div>

      {/* ───────────── Steps ───────────── */}
      <div role="tablist" aria-label="Add product steps" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {STEPS.map((label, i) => {
          const on = i === step
          const done = i < step
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => goTo(i)}
              className={`rounded-xl border px-3 py-3 text-left text-sm font-semibold transition-colors ${
                on ? "border-primary bg-primary text-white shadow" : done ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-emerald-100 bg-white text-neutral-600 hover:bg-emerald-50/50"
              }`}
            >
              {i + 1}. {label}
            </button>
          )
        })}
      </div>

      {/* ───────────── 1. Category ───────────── */}
      {step === 0 && (
        <section className={card}>
          <h2 className="text-base font-bold text-neutral-900">Step 1 · Choose the category</h2>
          <p className="mb-4 text-sm text-neutral-500">Pick where this product lives in the store.</p>

          <div className="mb-5 max-w-sm">
            <F k="restaurantId" label="Store" required>
              <select value={form.restaurantId} onChange={set("restaurantId")} disabled={editing} className={inp}>
                <option value="">Select Store</option>
                {stores.map((r) => <option key={r._id || r.id} value={r._id || r.id}>{r.restaurantName || r.name}</option>)}
              </select>
            </F>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" role="radiogroup" aria-label="Category">
            {topCategories.map((c) => {
              const id = catId(c)
              const on = form.categoryId === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pickCategory(id)}
                  className={`flex flex-col items-center gap-1.5 rounded-2xl border p-4 text-center transition-colors ${on ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "border-emerald-100 bg-white hover:bg-emerald-50/50"}`}
                >
                  {c.image ? <img src={c.image} alt="" className="h-9 w-9 object-contain" /> : <span className="text-3xl leading-none" aria-hidden="true">{categoryEmoji(c.name)}</span>}
                  <span className="text-sm font-semibold text-neutral-900">{c.name}</span>
                  <span className="text-xs text-neutral-500">{counts[id] || 0} products</span>
                </button>
              )
            })}
          </div>
          <Err>{errors.categoryId}</Err>

          {form.categoryId && (subCategories.length > 0 || true) && (
            <div className="mt-5">
              <p className="mb-2 text-sm font-semibold text-neutral-800">Sub category <span className="font-normal text-neutral-400">(optional)</span></p>
              <div className="flex flex-wrap gap-2">
                {subCategories.map((c) => {
                  const id = catId(c)
                  const on = form.subCategoryId === id
                  return (
                    <button key={id} type="button" onClick={() => setForm((f) => ({ ...f, subCategoryId: on ? "" : id }))} className={`rounded-full border px-3.5 py-1.5 text-sm ${on ? "border-primary bg-primary text-white" : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"}`}>
                      {c.name}
                    </button>
                  )
                })}
                {subCategories.length === 0 && <span className="text-sm text-neutral-400">None yet for {chosenCategory?.name || "this category"}.</span>}
              </div>
            </div>
          )}

          <div className="mt-6 border-t border-neutral-100 pt-4">
            <p className="mb-2 text-sm text-neutral-600">Not listed? Create a new category{form.categoryId ? ` (or a sub category of ${chosenCategory?.name || "the chosen one"})` : ""}</p>
            <div className="flex flex-wrap gap-2">
              <input
                value={newCat.name}
                onChange={(e) => setNewCat((m) => ({ ...m, name: e.target.value, error: "" }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategoryInline(false) } }}
                placeholder="e.g. Frozen food"
                className={`${inp} max-w-xs flex-1`}
              />
              <button type="button" disabled={savingCat} onClick={() => addCategoryInline(false)} className="inline-flex h-10 items-center gap-2 rounded-full border border-primary px-5 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50">
                {savingCat && <Loader2 className="h-4 w-4 animate-spin" />} Add category
              </button>
              {form.categoryId && (
                <button type="button" disabled={savingCat} onClick={() => addCategoryInline(true)} className="inline-flex h-10 items-center rounded-full border border-neutral-300 px-5 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
                  Add as sub category
                </button>
              )}
            </div>
            <Err>{newCat.error}</Err>
          </div>
        </section>
      )}

      {/* ───────────── 2. Product details ───────────── */}
      {step === 1 && (
        <section className={card}>
          <h2 className="text-base font-bold text-neutral-900">Step 2 · Product details</h2>
          <p className="mb-4 text-sm text-neutral-500">
            In {chosenCategory?.name || "—"}{chosenSub ? ` › ${chosenSub.name}` : ""} at {storeName || "—"}.{" "}
            <button type="button" onClick={() => setStep(0)} className="font-medium text-primary underline">Change</button>
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="md:col-span-2 xl:col-span-4">
              <Label>Product Images</Label>
              <div className="flex flex-wrap gap-3">
                {form.images.map((url, i) => (
                  <div key={url + i} className="group relative h-24 w-24 overflow-hidden rounded-lg border border-neutral-300 bg-neutral-50">
                    <img src={url} alt="" className="h-full w-full object-cover" />
                    {i === 0 ? (
                      <span className="absolute inset-x-0 bottom-0 bg-sky-500/90 py-0.5 text-center text-[10px] font-semibold text-white">Primary</span>
                    ) : (
                      <button type="button" onClick={() => makePrimary(i)} className="absolute inset-x-0 bottom-0 hidden bg-neutral-900/70 py-0.5 text-center text-[10px] font-semibold text-white group-hover:block">Make primary</button>
                    )}
                    <button type="button" onClick={() => removeImage(i)} className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-white/90 text-rose-600 shadow hover:bg-white"><Trash2 className="h-3 w-3" /></button>
                  </div>
                ))}
                <label className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-neutral-300 bg-neutral-50 text-center hover:border-sky-400 hover:bg-sky-50">
                  {uploading ? <Loader2 className="h-5 w-5 animate-spin text-neutral-400" /> : (
                    <>
                      <ImagePlus className="h-5 w-5 text-neutral-400" />
                      <span className="px-2 text-[11px] font-medium text-neutral-500">Add image{form.images.length ? "s" : ""}</span>
                    </>
                  )}
                  <input type="file" accept="image/*" multiple onChange={onImages} disabled={uploading} className="hidden" />
                </label>
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">First image is the primary shown across the app. Add as many as you need.</p>
            </div>

            <F k="itemCode" label="Item Code/Barcode" required right={!editing && (
              <label className="flex items-center gap-1.5 text-xs italic text-neutral-500">(Auto Generate)<input type="checkbox" checked={form.autoCode} onChange={set("autoCode")} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" /></label>
            )}>
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
            <F k="foodType" label="Food Type">
              <select value={form.foodType} onChange={set("foodType")} className={inp}>
                <option value="Veg">Veg</option>
                <option value="Non-Veg">Non-Veg</option>
              </select>
            </F>
            <F k="hsnCode" label="HSN Code">
              <input value={form.hsnCode} onChange={set("hsnCode")} placeholder="HSN Code" className={inp} />
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
            <F k="netWeightUnitId" label="Net Weight Unit">
              <select value={form.netWeightUnitId} onChange={set("netWeightUnitId")} className={inp}>
                <option value="">Select Unit</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.shortName})</option>)}
              </select>
            </F>
            <F k="netWeight" label="Net Weight"><input type="number" step="any" value={form.netWeight} onChange={set("netWeight")} placeholder="0" className={inp} /></F>

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
              <input type="date" data-testid="product-expiry" value={form.manageMultipleBatch ? "" : form.expiryDate} onChange={set("expiryDate")} disabled={form.manageMultipleBatch} className={`${inp} disabled:bg-neutral-100 disabled:text-neutral-400`} />
              <p className="mt-1 text-xs text-neutral-500">
                {form.manageMultipleBatch ? "Each batch carries its own expiry — set it when the stock is received." : "Leave blank for anything that does not expire."}
              </p>
            </F>

            <div className="md:col-span-2 xl:col-span-4">
              <Label>Short Description</Label>
              <textarea value={form.shortDescription} onChange={set("shortDescription")} rows={2} placeholder="Enter Short Description" className="w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-sky-500" />
            </div>
            <div className="md:col-span-2 xl:col-span-4">
              <Label>Description</Label>
              <textarea value={form.description} onChange={set("description")} rows={4} className="w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-sky-500" />
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
            <div className="md:col-span-2 xl:col-span-4">
              <F k="additionalInfo" label="Additional Info">
                <input value={form.additionalInfo} onChange={set("additionalInfo")} placeholder="Additional Info" className={inp} />
              </F>
            </div>
          </div>
        </section>
      )}

      {/* ───────────── 3. Pricing & stock ───────────── */}
      {step === 2 && (
        <section className={card}>
          <h2 className="text-base font-bold text-neutral-900">Step 3 · Pricing &amp; stock</h2>
          <p className="mb-4 text-sm text-neutral-500">What it costs, what it sells for, and how much is on the shelf.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          </div>

          <h3 className="mb-3 mt-6 text-sm font-bold text-neutral-900">Stock</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <F k="stockQty" label="Opening Qty"><input type="number" step="any" value={form.stockQty} onChange={set("stockQty")} placeholder="0" className={inp} /></F>
            {/* Left blank these inherit the outlet's defaults, which is how a
                shop with thousands of lines configures this at all. */}
            <F k="lowStockThreshold" label="Low Stock At"><input type="number" min={0} value={form.lowStockThreshold} onChange={set("lowStockThreshold")} placeholder="outlet default" className={inp} /></F>
            <F k="criticalStockThreshold" label="Critical Stock At"><input type="number" min={0} value={form.criticalStockThreshold} onChange={set("criticalStockThreshold")} placeholder="outlet default" className={inp} /></F>
            <F k="outOfStockThreshold" label="Out Of Stock At"><input type="number" min={0} value={form.outOfStockThreshold} onChange={set("outOfStockThreshold")} placeholder="outlet default" className={inp} /></F>
          </div>

          <div className="mt-6 rounded-xl border border-neutral-200 p-4 text-center">
            <button type="button" onClick={addVariant} className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:opacity-90">Add Variant</button>
            <p className="mt-2 text-sm text-neutral-700">Add variants if this product comes in multiple versions, like different sizes or colours.</p>
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
          </div>
        </section>
      )}

      {/* ───────────── 4. Availability ───────────── */}
      {step === 3 && (
        <section className={card}>
          <h2 className="text-base font-bold text-neutral-900">Step 4 · Availability</h2>
          <p className="mb-4 text-sm text-neutral-500">Whether customers can see and buy this product.</p>
          <div className="space-y-3">
            {toggleRow(form.isAvailable, set("isAvailable"), "Available to customers", "Switch off to hide it from the app without deleting it. Stock is kept.")}
            {toggleRow(form.isRecommended, set("isRecommended"), "Recommended product", "Highlights it on the store page.")}
            <div className="max-w-sm">
              <F k="preparationTime" label="Preparation / pack time">
                <input value={form.preparationTime} onChange={set("preparationTime")} placeholder="e.g. 10 mins" className={inp} />
              </F>
            </div>
          </div>
        </section>
      )}

      {/* ───────────── 5. Subscription ───────────── */}
      {step === 4 && (
        <section className={card}>
          <h2 className="text-base font-bold text-neutral-900">Step 5 · Subscription</h2>
          <p className="mb-4 text-sm text-neutral-500">Let customers get this delivered on a repeating schedule (daily milk, weekly vegetables).</p>
          {toggleRow(form.subscriptionEnabled, set("subscriptionEnabled"), "Allow customers to subscribe", "Customers can pick the days and delivery time. Each delivery is billed as a normal order.")}
          {form.subscriptionEnabled && (
            <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Make sure the product has a price and stock: subscriptions are refused for products that cannot be sold.
            </p>
          )}
        </section>
      )}

      {/* ───────────── 6. Review ───────────── */}
      {step === 5 && (
        <section className={card}>
          <h2 className="text-base font-bold text-neutral-900">Step 6 · Review</h2>
          <p className="mb-4 text-sm text-neutral-500">Check everything, then save. Use Edit to fix anything.</p>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              { title: "Category", at: 0, rows: [["Store", storeName], ["Category", chosenCategory?.name], ["Sub category", chosenSub?.name]] },
              { title: "Product details", at: 1, rows: [["Name", form.name], ["Item code", form.autoCode && !editing ? `${form.itemCode || "—"} (auto)` : form.itemCode], ["Brand", brandName], ["Unit", unitName], ["Sales tax", form.gstRate === "" ? "" : `GST ${form.gstRate}%`], ["HSN", form.hsnCode], ["Images", `${form.images.length}`]] },
              { title: "Pricing & stock", at: 2, rows: [["MRP", form.mrp && `₹${form.mrp}`], ["Selling price", form.price && `₹${form.price}`], ["Online price", form.onlinePrice && `₹${form.onlinePrice}`], ["Purchase price", form.purchasePrice && `₹${form.purchasePrice}`], ["Opening qty", form.stockQty], ["Variants", `${form.variants.filter((v) => v.name.trim()).length}`]] },
              { title: "Availability & subscription", at: 3, rows: [["Available to customers", form.isAvailable ? "Yes" : "No"], ["Recommended", form.isRecommended ? "Yes" : "No"], ["Subscriptions", form.subscriptionEnabled ? "Allowed" : "Not allowed"]] },
            ].map((g) => (
              <div key={g.title} className="rounded-xl border border-neutral-200 p-4">
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-neutral-900">{g.title}</h3>
                  <button type="button" onClick={() => setStep(g.at)} className="text-xs font-semibold text-primary underline">Edit</button>
                </div>
                {g.rows.map(([label, value]) => <div key={label}>{row(label, value)}</div>)}
              </div>
            ))}
          </div>
          {form.images[0] && <img src={form.images[0]} alt="" className="mt-4 h-24 w-24 rounded-lg border border-neutral-200 object-cover" />}
        </section>
      )}

      {/* ───────────── Footer ───────────── */}
      <div className="sticky bottom-0 -mx-4 mt-4 flex items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-100/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <button type="button" onClick={() => setStep((x) => Math.max(0, x - 1))} disabled={step === 0} className="rounded-full border border-neutral-300 bg-white px-6 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">Back</button>
        {!last ? (
          <button type="button" onClick={next} className="rounded-full bg-primary px-7 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90">Next</button>
        ) : (
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={() => save(false)} className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {editing ? "Save changes" : "Save product"}
            </button>
            {!editing && (
              <button type="button" disabled={saving} onClick={() => save(true)} className="rounded-full border border-primary bg-white px-6 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-60">
                Save &amp; add another
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    </FieldErrorsContext.Provider>
  )
}
