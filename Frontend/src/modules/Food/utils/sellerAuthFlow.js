/**
 * Where the partner sign-in pages send people.
 *
 * The seller panel and the point of sale share one account system (a store signs in with its phone
 * and an OTP either way), but they are separate apps with their own addresses. The Login and OTP
 * pages take a flow so each app keeps its own sign-in and lands back in itself afterwards, while
 * the sign-in logic itself stays in one place.
 *
 * Onboarding and the pending-approval screen are seller-panel pages in both flows: a store that has
 * not finished signing up does that in the panel, not at the till.
 */
export const SELLER_FLOW = {
  loginPath: "/seller/login",
  otpPath: "/seller/otp",
  homePath: "/seller",
  title: "Partner sign in",
  portalLabel: "Partner Portal",
}

export const POS_FLOW = {
  loginPath: "/pos/login",
  // The store owner can also sign in to the till with phone + OTP, from /pos/owner-login.
  ownerLoginPath: "/pos/owner-login",
  otpPath: "/pos/otp",
  homePath: "/pos",
  title: "POS sign in",
  portalLabel: "Point of Sale",
}
