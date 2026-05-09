import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";

// Unit types that a cluster warhead can damage on its landing tile.
// Mirrors WARHEAD_DAMAGEABLE in StrategicBomberExecution.
const CLUSTER_DAMAGEABLE = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Airbase,
  UnitType.NavalYard,
  UnitType.CoastalBattery,
  UnitType.DefensePost,
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.Carrier,
  UnitType.TransportShip,
] as const;

const SEARCH_RADIUS = 1;

/**
 * A single cluster-bomb warhead. Visualised by reusing the `Shell` unit type
 * — when the warhead reaches its landing tile it calls `setReachedTarget()`
 * and deletes, which the FX layer picks up and plays a `MiniExplosion`.
 *
 * Damage is applied on impact (not at release time) so the visual and the
 * gameplay effect line up.
 */
export class ClusterBombExecution implements Execution {
  private active = true;
  private pathFinder: SteppingPathFinder<TileRef>;
  private shell: Unit | undefined;
  private mg: Game;

  constructor(
    private spawn: TileRef,
    private owner: Player,
    private targetTile: TileRef,
    private damagePerWarhead: number,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
  }

  tick(_ticks: number): void {
    this.shell ??= this.owner.buildUnit(UnitType.Shell, this.spawn, {});
    if (!this.shell.isActive()) {
      this.active = false;
      return;
    }

    for (let i = 0; i < 3; i++) {
      const result = this.pathFinder.next(this.shell.tile(), this.targetTile);
      if (result.status === PathStatus.COMPLETE) {
        this.detonate();
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.shell.move(result.node);
      }
    }
  }

  private detonate(): void {
    if (!this.shell) return;
    // Damage all enemy units within SEARCH_RADIUS of the landing tile.
    const nearby = this.mg.nearbyUnits(
      this.targetTile,
      SEARCH_RADIUS,
      CLUSTER_DAMAGEABLE,
    );
    for (const { unit } of nearby) {
      if (
        unit.owner() !== this.owner &&
        this.owner.canAttackPlayer(unit.owner(), true) &&
        unit.isActive()
      ) {
        const multiplier = this.mg
          .config()
          .combatMultiplier(UnitType.Bomber, unit.type());
        unit.modifyHealth(
          -Math.round(this.damagePerWarhead * multiplier),
          this.owner,
        );
      }
    }
    this.shell.setReachedTarget();
    this.shell.delete(false);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
