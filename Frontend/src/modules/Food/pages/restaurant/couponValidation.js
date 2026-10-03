/**
 * Client-side rules for a seller coupon, matching what the server enforces.
 * Returns { field: message } -- empty when the form is valid.
 */
export function validateCouponForm(formData, todayDateString) {
  const e = {}
  if (!String(formData.couponCode || "").trim()) e.couponCode = "Coupon code is required"
  if (!formData.discountValue || isNaN(formData.discountValue) || Number(formData.discountValue) <= 0)
    e.discountValue = "Enter a valid discount value"
  if (formData.discountType === "percentage" && Number(formData.discountValue) > 100)
    e.discountValue = "Percentage cannot exceed 100"
  // The server refuses a percentage coupon with no cap (an uncapped % off a
  // big basket is an open-ended giveaway), so say so here instead of letting
  // the field read as optional and failing on submit with a raw field name.
  if (formData.discountType === "percentage" && (!formData.maxDiscount || Number(formData.maxDiscount) <= 0))
    e.maxDiscount = "Enter the maximum discount (in ₹) a percentage coupon can give"
  // A monthly offer auto-fills its window to the current calendar month
  // when left blank, so dates aren't mandatory for it.
  if (!formData.isMonthly) {
    if (!formData.startDate) e.startDate = "Start date is required"
    if (!formData.endDate) e.endDate = "End date is required"
  }
  if (formData.startDate && formData.startDate < todayDateString)
    e.startDate = "Start date cannot be in the past"
  if (formData.startDate && formData.endDate && new Date(formData.startDate) > new Date(formData.endDate))
    e.endDate = "End date must be after start date"
  return e
}
