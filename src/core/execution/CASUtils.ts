import { Game, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

/**
 * Shared utility for Close Air Support / ground-attack units.
 * Used by AttackHelicopterExecution and any future CAS variants to avoid
 * duplicating the findNearest/patrol/moveToward pattern.
 */
export class CASUtils {
  static findNearest(
    mg: Game,
    attacker: Unit,
    range: number,
    targetTypes: readonly UnitType[],
  ): Unit | undefined {
    const owner = attacker.owner();
    const nearby = mg.nearbyUnits(attacker.tile()!, range, targetTypes);
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of nearby) {
      if (
        unit.owner() !== owner &&
        owner.canAttackPlayer(unit.owner(), true) &&
        distSquared < bestDist
      ) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  static randomPatrolTile(
    mg: Game,
    homeBaseTile: TileRef,
    random: PseudoRandom,
    range: number,
    preferLand: boolean,
  ): TileRef {
    for (let i = 0; i < 50; i++) {
      const x = mg.x(homeBaseTile) + random.nextInt(-range / 2, range / 2);
      const y = mg.y(homeBaseTile) + random.nextInt(-range / 2, range / 2);
      if (mg.isValidCoord(x, y)) {
        const tile = mg.ref(x, y);
        if (!preferLand || mg.isLand(tile)) return tile;
      }
    }
    return homeBaseTile;
  }

  /**
   * Move `unit` toward `target` using `pathFinder` at `moveSpeed` steps/tick.
   * Returns an optionally refreshed path finder (same instance unless blocked).
   */
  static moveToward(
    mg: Game,
    pathFinder: SteppingPathFinder<TileRef>,
    unit: Unit,
    target: TileRef,
    moveSpeed: number,
  ): SteppingPathFinder<TileRef> {
    for (let i = 0; i < moveSpeed; i++) {
      const result = pathFinder.next(unit.tile(), target);
      if (result.status === PathStatus.NEXT) {
        unit.move(result.node);
      } else if (result.status === PathStatus.COMPLETE) {
        break;
      } else {
        return PathFinding.Air(mg);
      }
    }
    return pathFinder;
  }
}
