import { Player, UnitType } from "../game/Game";

/**
 * Range multiplier scaling with the number of active friendly airbases.
 *
 * Each airbase past the first adds +20% range, up to +80% at 5 airbases.
 * Carriers do NOT count toward this multiplier — only fixed airbases boost
 * range, since the doctrine is "logistics network increases reach".
 *
 *   1 airbase  → 1.00x
 *   2 airbases → 1.20x
 *   3 airbases → 1.40x
 *   4 airbases → 1.60x
 *   5+         → 1.80x
 */
export function airbaseRangeMultiplier(owner: Player): number {
  let count = 0;
  for (const u of owner.units(UnitType.Airbase)) {
    if (u.isActive() && !u.isUnderConstruction()) count++;
  }
  return 1.0 + 0.2 * Math.min(Math.max(count - 1, 0), 4);
}
