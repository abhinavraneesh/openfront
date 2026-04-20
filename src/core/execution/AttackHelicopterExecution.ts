import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Unit,
  UnitParams,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

// Helicopters are slower air units — they use air pathfinding but prefer land
// (no fuel, unlimited operation, patrol radius around spawn city)
const HELI_TARGETS = [UnitType.DefensePost, UnitType.SAMLauncher] as const;

export class AttackHelicopterExecution implements Execution {
  private heli: Unit;
  private mg: Game;
  private pathFinder: SteppingPathFinder<TileRef>;
  private random: PseudoRandom;
  private homeBaseTile: TileRef;
  private lastAttack = 0;

  constructor(
    private input: (UnitParams<UnitType.AttackHelicopter> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = PathFinding.Air(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.heli = this.input;
      this.homeBaseTile = this.heli.patrolTile() ?? this.heli.tile();
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.AttackHelicopter,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn AttackHelicopter`);
        return;
      }
      this.homeBaseTile = spawn;
      this.heli = this.input.owner.buildUnit(UnitType.AttackHelicopter, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
  }

  tick(ticks: number): void {
    if (!this.heli?.isActive()) return;
    if (this.heli.health() <= 0) {
      this.heli.delete();
      return;
    }

    // Heal passively if owner has a city
    if (this.heli.owner().unitCount(UnitType.City) > 0) {
      this.heli.modifyHealth(1);
    }

    const info = this.mg.config().unitInfo(UnitType.AttackHelicopter);
    const moveSpeed = info.moveSpeed ?? 2;
    const range = info.range ?? 40;
    const attackRate = info.attackRate ?? 10;
    const damage = info.damage ?? 150;

    // Check for attack targets within range
    const target = this.findTarget(range);
    if (target) {
      this.heli.setTargetUnit(target);
      this.moveToward(target.tile(), moveSpeed);
      if (
        this.mg.manhattanDist(this.heli.tile(), target.tile()) <= 4 &&
        this.mg.ticks() - this.lastAttack > attackRate
      ) {
        this.lastAttack = this.mg.ticks();
        target.modifyHealth(-damage, this.heli.owner());
      }
    } else {
      this.heli.setTargetUnit(undefined);
      this.patrol(moveSpeed);
    }
  }

  private findTarget(range: number): Unit | undefined {
    const owner = this.heli.owner();
    const nearby = this.mg.nearbyUnits(this.heli.tile()!, range, HELI_TARGETS);
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

  private patrol(moveSpeed: number): void {
    if (this.heli.targetTile() === undefined) {
      this.heli.setTargetTile(this.randomPatrolTile());
    }
    if (this.heli.targetTile() !== undefined) {
      this.moveToward(this.heli.targetTile()!, moveSpeed);
      if (
        this.mg.manhattanDist(this.heli.tile(), this.heli.targetTile()!) === 0
      ) {
        this.heli.setTargetTile(undefined);
        this.pathFinder = PathFinding.Air(this.mg);
      }
    }
  }

  private moveToward(target: TileRef, moveSpeed: number): void {
    for (let i = 0; i < moveSpeed; i++) {
      const result = this.pathFinder.next(this.heli.tile(), target);
      if (result.status === PathStatus.NEXT) {
        this.heli.move(result.node);
      } else if (result.status === PathStatus.COMPLETE) {
        break;
      } else {
        this.pathFinder = PathFinding.Air(this.mg);
        break;
      }
    }
  }

  private randomPatrolTile(): TileRef {
    const range = 40;
    const mg = this.mg;
    for (let i = 0; i < 50; i++) {
      const x =
        mg.x(this.homeBaseTile) + this.random.nextInt(-range / 2, range / 2);
      const y =
        mg.y(this.homeBaseTile) + this.random.nextInt(-range / 2, range / 2);
      if (mg.isValidCoord(x, y)) {
        const tile = mg.ref(x, y);
        // Prefer land tiles for helicopters
        if (mg.isLand(tile)) return tile;
      }
    }
    return this.homeBaseTile;
  }

  isActive(): boolean {
    return this.heli?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
