import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"

/**
 * Loads the Google Maps script with the Places library, once.
 *
 * Several screens already inject the script themselves; this checks for one
 * before adding another, because a second copy of the Maps script logs a
 * warning and can break the first one's callbacks.
 *
 * Resolves to `window.google.maps.places`, or rejects with a message the
 * caller can show (no key configured, blocked script, key without Places).
 */

let pending = null

const placesReady = () => Boolean(window.google?.maps?.places?.Autocomplete)

export function loadGooglePlaces() {
  if (placesReady()) return Promise.resolve(window.google.maps.places)
  if (pending) return pending

  pending = (async () => {
    const apiKey = await getGoogleMapsApiKey()
    if (!apiKey) throw new Error("Google Maps key is not set in the admin settings")

    const existing = Array.from(document.scripts).find((s) => s.src?.includes("maps.googleapis.com/maps/api/js"))
    if (!existing) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script")
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&v=weekly`
        script.async = true
        script.onload = resolve
        script.onerror = () => reject(new Error("Could not load Google Maps"))
        document.head.appendChild(script)
      })
    }

    // A script added by another screen may not include the Places library, or may
    // still be loading; wait briefly for it rather than failing on a race.
    for (let i = 0; i < 40 && !placesReady(); i += 1) {
      await new Promise((r) => setTimeout(r, 150))
    }
    if (!placesReady()) throw new Error("Google Places is not available for this key")
    return window.google.maps.places
  })().catch((err) => {
    pending = null
    throw err
  })

  return pending
}

/** Picks the first address component of any of the given types. */
const pick = (components = [], ...types) => {
  for (const type of types) {
    const hit = components.find((c) => c.types?.includes(type))
    if (hit) return hit.long_name
  }
  return ""
}

/** A Places result turned into the fields the customer address needs. */
export function addressFromPlace(place) {
  const location = place?.geometry?.location
  if (!location) return null
  const comps = place.address_components || []
  return {
    street: place.formatted_address || place.name || "",
    city: pick(comps, "locality", "administrative_area_level_3", "administrative_area_level_2", "sublocality_level_1"),
    state: pick(comps, "administrative_area_level_1"),
    zipCode: pick(comps, "postal_code"),
    lat: location.lat(),
    lng: location.lng(),
  }
}

/**
 * Finds a typed address on the map.
 *
 * For the admin who typed the address out instead of picking a suggestion: the
 * position is what makes it deliverable, so it is looked up for them. Resolves to
 * { lat, lng }, or null when Google cannot place it (or Maps cannot be loaded).
 */
export async function geocodeAddress(text) {
  try {
    await loadGooglePlaces()
  } catch {
    return null
  }
  if (!window.google?.maps?.Geocoder) return null
  return new Promise((resolve) => {
    new window.google.maps.Geocoder().geocode(
      { address: String(text || ""), componentRestrictions: { country: "IN" } },
      (results, status) => {
        const hit = status === "OK" ? results?.[0]?.geometry?.location : null
        resolve(hit ? { lat: hit.lat(), lng: hit.lng() } : null)
      },
    )
  })
}
