/**
 * What the seller's "Getting Started" checklist reads from the API.
 *
 * Both shapes below were read wrongly once: the menu endpoint answers
 * { menu: { sections: [{ items }] } } (not a flat list), and the profile folds the
 * address into `location` (there is no top-level address). Either mistake left a
 * fully set-up store at 0%.
 */

export const extractRestaurant = (response) =>
  response?.data?.data?.restaurant ||
  response?.data?.restaurant ||
  response?.data?.data?.user ||
  response?.data?.user ||
  response?.data?.data ||
  null

export const extractMenuCount = (response) => {
  const data = response?.data?.data || response?.data || {}
  if (Array.isArray(data?.items)) return data.items.length
  if (Array.isArray(data?.foods)) return data.foods.length
  if (Array.isArray(data)) return data.length
  if (typeof data?.total === 'number') return data.total
  const sections = data?.menu?.sections
  if (Array.isArray(sections)) {
    return sections.reduce((n, section) => {
      const own = Array.isArray(section?.items) ? section.items.length : 0
      const nested = Array.isArray(section?.subsections)
        ? section.subsections.reduce((m, sub) => m + (Array.isArray(sub?.items) ? sub.items.length : 0), 0)
        : 0
      return n + own + nested
    }, 0)
  }
  return 0
}

export const hasOutletAddress = (restaurant) => {
  const loc = restaurant?.location
  return Boolean(
    restaurant?.address ||
      restaurant?.addressLine1 ||
      loc?.formattedAddress ||
      loc?.address ||
      loc?.addressLine1,
  )
}

/** Completed flags for the four setup steps, in display order. */
export const checklistState = (restaurant, menuItemCount) => ({
  profile: hasOutletAddress(restaurant) && Boolean(restaurant?.fssaiNumber),
  menu: menuItemCount > 0,
  zone: Boolean(restaurant?.zoneId),
  bank: Boolean(restaurant?.accountNumber && restaurant?.ifscCode),
})

export const checklistPercent = (state) => {
  const done = Object.values(state).filter(Boolean).length
  return Math.round((done / Object.values(state).length) * 100)
}
