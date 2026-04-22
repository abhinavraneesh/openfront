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
import { SteppingPathFinder } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
import { CASUtils } from "./CASUtils";

// Helicopters are slower air units — they use air pathfinding but prefer land
// (no fuel, unlimited operation, patrol radius around spawn city)
const HELI_TARGETS = [UnitType.DefensePost, UnitType.SAMLauncher] as const;
const HELI_PATROL_RANGE = 40;

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
        const multiplier = this.mg
          .config()
          .combatMultiplier(UnitType.AttackHelicopter, target.type());
        target.modifyHealth(
          -Math.round(damage * multiplier),
          this.heli.owner(),
        );
      }
    } else {
      this.heli.setTargetUnit(undefined);
      this.patrol(moveSpeed);
    }
  }

  private findTarget(range: number): Unit | undefined {
    return CASUtils.findNearest(this.mg, this.heli, range, HELI_TARGETS);
  }

  private patrol(moveSpeed: number): void {
    if (this.heli.targetTile() === undefined) {
      this.heli.setTargetTile(
        CASUtils.randomPatrolTile(
          this.mg,
          this.homeBaseTile,
          this.random,
          HELI_PATROL_RANGE,
          true,
        ),
      );
    }
    if (this.heli.targetTile() !== undefined) {
      this.pathFinder = CASUtils.moveToward(
        this.mg,
        this.pathFinder,
        this.heli,
        this.heli.targetTile()!,
        moveSpeed,
      );
      if (
        this.mg.manhattanDist(this.heli.tile(), this.heli.targetTile()!) === 0
      ) {
        this.heli.setTargetTile(undefined);
        this.pathFinder = PathFinding.Air(this.mg);
      }
    }
  }

  private moveToward(target: TileRef, moveSpeed: number): void {
    this.pathFinder = CASUtils.moveToward(
      this.mg,
      this.pathFinder,
      this.heli,
      target,
      moveSpeed,
    );
  }

  isActive(): boolean {
    return this.heli?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
