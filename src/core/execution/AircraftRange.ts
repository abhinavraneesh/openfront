import { Player, Unit, UnitType } from "../game/Game";

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
export const CARRIER_CAPACITY = 6;

/**
 * Count aircraft currently on a carrier's deck (same tile, any mission).
 * Used to enforce CARRIER_CAPACITY before assigning a carrier as home base.
 */
export function carrierDockedCount(carrier: Unit): number {
  const owner = carrier.owner();
  const tile = carrier.tile();
  let count = 0;
  for (const type of [
    UnitType.Fighter,
    UnitType.TacticalBomber,
    UnitType.StrategicBomber,
    UnitType.AttackHelicopter,
  ] as const) {
    for (const u of owner.units(type)) {
      if (u.isActive() && u.tile() === tile) count++;
    }
  }
  return count;
}

export function airbaseRangeMultiplier(owner: Player): number {
  let count = 0;
  for (const u of owner.units(UnitType.Airbase)) {
    if (u.isActive() && !u.isUnderConstruction()) count++;
  }
  return 1.0 + 0.2 * Math.min(Math.max(count - 1, 0), 4);
}
