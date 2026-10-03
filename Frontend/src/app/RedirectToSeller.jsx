import { Navigate, useLocation } from 'react-router-dom'
import { toSellerPath } from './sellerRedirect'

/**
 * Sends the old /food/restaurant/* and bare /restaurant/* addresses to /seller/*.
 *
 * A redirect rather than a second mount: two live copies of the panel would
 * mean two sessions, two sets of sockets, and a bug fixed in one of them. The
 * rest of the path, the query string and the hash survive, so a deep link to a
 * specific order still lands on it.
 */
const RedirectToSeller = () => {
  const location = useLocation()
  return <Navigate to={toSellerPath(location.pathname) + location.search + location.hash} replace />
}

export default RedirectToSeller
