/**
 * Maps the old seller addresses onto /seller/*.
 *
 * Both prefixes are handled: /food/restaurant/* (the original) and a bare
 * /restaurant/*, which many seller screens still navigate to. The lookahead
 * keeps /restaurants (a different word) and /restaurant-x from matching.
 */
export const toSellerPath = (pathname = '') =>
  String(pathname).replace(/^\/(?:food\/)?restaurant(?=\/|$)/, '/seller')
