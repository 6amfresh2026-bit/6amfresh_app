/**
 * Kilometres to the next stop, for the rider's pickup card.
 *
 * Before a GPS fix the distance is Infinity, which used to print "INFINITY KM".
 * Anything that is not a finite number of metres reads as unknown instead.
 */
export const formatKmToTarget = (distanceMeters) =>
  Number.isFinite(distanceMeters) ? (distanceMeters / 1000).toFixed(1) : '--'
