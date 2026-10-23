import { useEffect } from "react"
import { applyModuleBranding, applyModulePowerScanning, getCachedSettings, loadBusinessSettings } from "@food/utils/businessSettings"

/**
 * What every screen of the store-side apps (the seller panel and the point of sale) does to the
 * page: it keeps the customer app's dark mode out, and applies the store app's configured colour
 * and branding. Lives here so both apps look the same without each repeating it.
 */
export default function useRestaurantAppTheme() {
  // Safely enforce light mode for the Restaurant app to prevent User dark mode bleeding
  useEffect(() => {
    document.documentElement.classList.remove('dark');
    return () => {
      const savedTheme = localStorage.getItem('appTheme') || 'light';
      if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
      }
    };
  }, []);

  /**
   * The seller panel's own colour, which it never actually wore.
   *
   * applyModuleBranding only swaps the favicon and the page title.
   * applyModulePowerScanning is the one that sets --module-theme-color and
   * injects the stylesheet remapping the legacy brand hexes onto it, and
   * nothing here called it -- so the panel ignored its configured colour and
   * showed whatever hex each screen had hardcoded. Half of them had the
   * customer app's pink rather than the seller blue.
   */
  useEffect(() => {
    const applyBranding = async () => {
      const cached = getCachedSettings()
      if (cached) {
        applyModuleBranding("restaurant", cached)
        applyModulePowerScanning("restaurant", cached)
      } else {
        const settings = await loadBusinessSettings()
        applyModuleBranding("restaurant", settings)
        applyModulePowerScanning("restaurant", settings)
      }
    }

    applyBranding()
    const handleSettingsUpdate = () => applyBranding()
    window.addEventListener("businessSettingsUpdated", handleSettingsUpdate)
    return () => window.removeEventListener("businessSettingsUpdated", handleSettingsUpdate)
  }, [])
}
