import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Unit,
  UnitMission,
  UnitParams,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

type Phase = "patrol" | "intercept" | "returning";

const AIR_TYPES = [
  UnitType.Fighter,
  UnitType.TacticalBomber,
  UnitType.StrategicBomber,
  UnitType.AttackHelicopter,
] as const;

export class FighterExecution implements Execution {
  private fighter: Unit;
  private mg: Game;
  private pathFinder: SteppingPathFinder<TileRef>;
  private random: PseudoRandom;
  private phase: Phase = "patrol";
  private fuel = 80;
  private maxFuel = 80;
  private homeBaseTile: TileRef;
  private lastAttack = 0;

  constructor(
    private input: (UnitParams<UnitType.Fighter> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = PathFinding.Air(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.fighter = this.input;
      this.homeBaseTile = this.fighter.patrolTile() ?? this.fighter.tile();
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Fighter,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn Fighter for ${this.input.owner.name()}`);
        return;
      }
      this.homeBaseTile = spawn;
      this.fighter = this.input.owner.buildUnit(UnitType.Fighter, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
    const info = mg.config().unitInfo(UnitType.Fighter);
    this.maxFuel = info.maxFuel ?? 80;
    this.fuel = this.maxFuel;
  }

  tick(ticks: number): void {
    if (!this.fighter?.isActive()) return;
    if (this.fighter.health() <= 0) {
      this.fighter.delete();
      return;
    }

    // Home base lookup: find the nearest live friendly airbase or carrier.
    // The fighter only dies if NO friendly airbase or carrier exists anywhere.
    if (!this.updateHomeBase()) {
      this.fighter.delete();
      return;
    }

    const info = this.mg.config().unitInfo(UnitType.Fighter);
    const moveSpeed = info.moveSpeed ?? 4;
    const mission = this.fighter.mission();

    // STAND_DOWN: if already docked, hold position and burn no fuel.
    // If airborne, return home (fuel still ticks during return).
    if (mission === UnitMission.STAND_DOWN) {
      const docked =
        this.mg.manhattanDist(this.fighter.tile(), this.homeBaseTile) <= 1;
      if (docked) {
        this.fuel = this.maxFuel;
        return;
      }
      if (this.phase === "intercept" || this.phase === "patrol") {
        this.fighter.setTargetUnit(undefined);
        this.transitionTo("returning");
      }
      this.fuel--;
      if (this.fuel <= 0) {
        this.fighter.delete();
        return;
      }
      this.checkFuelDepotRefuel();
      this.doReturn(moveSpeed);
      return;
    }

    // Burn fuel while airborne on any other mission.
    this.fuel--;
    if (this.fuel <= 0) {
      this.fighter.delete();
      return;
    }
    this.checkFuelDepotRefuel();

    switch (this.phase) {
      case "patrol":
        this.doPatrol(
          moveSpeed,
          info.range ?? 50,
          info.attackRate ?? 8,
          info.damage ?? 200,
          mission,
        );
        break;
      case "intercept":
        this.doIntercept(moveSpeed, info.attackRate ?? 8, info.damage ?? 200);
        break;
      case "returning":
        this.doReturn(moveSpeed);
        break;
    }
  }

  /**
   * Find the nearest live friendly airbase or carrier and update homeBaseTile.
   * Returns false only when no friendly airbase or carrier exists anywhere —
   * which is the only condition under which the fighter should self-destruct.
   *
   * The original implementation only looked within 3 tiles of the ORIGINAL
   * spawn tile, so destroying that single airbase killed all stationed
   * fighters mid-flight even when other friendly airbases existed.
   */
  private updateHomeBase(): boolean {
    const owner = this.fighter.owner();
    const here = this.fighter.tile();
    let best: TileRef | undefined;
    let bestDist = Infinity;

    for (const u of owner.units(UnitType.Airbase)) {
      if (!u.isActive() || u.isUnderConstruction()) continue;
      const d = this.mg.euclideanDistSquared(here, u.tile());
      if (d < bestDist) {
        best = u.tile();
        bestDist = d;
      }
    }
    for (const u of owner.units(UnitType.Carrier)) {
      if (!u.isActive()) continue;
      const d = this.mg.euclideanDistSquared(here, u.tile());
      if (d < bestDist) {
        best = u.tile();
        bestDist = d;
      }
    }

    if (best === undefined) return false;
    this.homeBaseTile = best;
    return true;
  }

  private findNearestCarrier(): Unit | undefined {
    const owner = this.fighter.owner();
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const u of owner.units(UnitType.Carrier)) {
      if (!u.isActive()) continue;
      const d = this.mg.euclideanDistSquared(this.fighter.tile(), u.tile());
      if (d < bestDist) {
        best = u;
        bestDist = d;
      }
    }
    return best;
  }

  private checkFuelDepotRefuel(): void {
    const owner = this.fighter.owner();
    const nearby = this.mg.nearbyUnits(this.fighter.tile(), 5, [
      UnitType.FuelDepot,
    ]);
    for (const { unit } of nearby) {
      if (
        unit.owner() === owner &&
        unit.isActive() &&
        !unit.isUnderConstruction()
      ) {
        this.fuel = Math.min(this.fuel + 20, this.maxFuel);
        break;
      }
    }
  }

  private distToHome(): number {
    return this.mg.manhattanDist(this.fighter.tile(), this.homeBaseTile);
  }

  private shouldReturnHome(moveSpeed: number): boolean {
    // Return when fuel barely covers the trip home (with margin)
    return this.fuel < Math.ceil(this.distToHome() / moveSpeed) * 2 + 8;
  }

  private doPatrol(
    moveSpeed: number,
    range: number,
    attackRate: number,
    damage: number,
    mission: UnitMission | undefined,
  ): void {
    if (this.shouldReturnHome(moveSpeed)) {
      this.transitionTo("returning");
      return;
    }

    // INTERCEPT_HOME: scramble if enemy aircraft comes within 8 tiles of home base
    if (mission === UnitMission.INTERCEPT_HOME || mission === undefined) {
      const baseThreats = this.findAircraftNearBase(8);
      if (baseThreats) {
        this.fighter.setTargetUnit(baseThreats);
        this.transitionTo("intercept");
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("show-message", {
              detail: {
                message: "Fighter scrambled — enemy aircraft detected",
                duration: 3000,
                color: "yellow",
              },
            }),
          );
        }
        return;
      }
    }

    // Regular patrol: react to enemies in fighter's own sensor range
    const target = this.findEnemyAircraft(range);
    if (target) {
      this.fighter.setTargetUnit(target);
      this.transitionTo("intercept");
      return;
    }

    const patrolCenter = this.patrolCenter();
    if (this.fighter.targetTile() === undefined) {
      this.fighter.setTargetTile(this.randomPatrolTile(patrolCenter));
    }
    if (this.fighter.targetTile() !== undefined) {
      this.moveToward(this.fighter.targetTile()!, moveSpeed);
      if (
        this.mg.manhattanDist(
          this.fighter.tile(),
          this.fighter.targetTile()!,
        ) === 0
      ) {
        this.fighter.setTargetTile(undefined);
        this.transitionTo("patrol");
      }
    }
  }

  private patrolCenter(): TileRef {
    if (this.fighter.mission() === UnitMission.INTERCEPT_PATROL) {
      return this.fighter.missionTargetTile() ?? this.homeBaseTile;
    }
    return this.homeBaseTile;
  }

  private findAircraftNearBase(radius: number): Unit | undefined {
    const owner = this.fighter.owner();
    const nearby = this.mg.nearbyUnits(this.homeBaseTile, radius, AIR_TYPES);
    for (const { unit } of nearby) {
      if (
        unit !== this.fighter &&
        unit.owner() !== owner &&
        owner.canAttackPlayer(unit.owner(), true)
      ) {
        return unit;
      }
    }
    return undefined;
  }

  private doIntercept(
    moveSpeed: number,
    attackRate: number,
    damage: number,
  ): void {
    const target = this.fighter.targetUnit();
    if (!target?.isActive()) {
      this.fighter.setTargetUnit(undefined);
      this.transitionTo("returning");
      return;
    }
    if (this.shouldReturnHome(moveSpeed)) {
      this.fighter.setTargetUnit(undefined);
      this.transitionTo("returning");
      return;
    }

    this.moveToward(target.tile(), moveSpeed);

    if (
      this.mg.manhattanDist(this.fighter.tile(), target.tile()) <= 3 &&
      this.mg.ticks() - this.lastAttack > attackRate
    ) {
      this.lastAttack = this.mg.ticks();
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Fighter, target.type());
      target.modifyHealth(
        -Math.round(damage * multiplier),
        this.fighter.owner(),
      );
      if (!target.isActive() || target.health() <= 0) {
        this.fighter.setTargetUnit(undefined);
        this.transitionTo("returning");
      }
    }
  }

  private doReturn(moveSpeed: number): void {
    const carrier = this.findNearestCarrier();
    const returnTarget = carrier?.tile() ?? this.homeBaseTile;
    this.moveToward(returnTarget, moveSpeed);
    if (this.mg.manhattanDist(this.fighter.tile(), returnTarget) <= 1) {
      this.fuel = this.maxFuel;
      this.fighter.modifyHealth(10);
      this.transitionTo("patrol");
    }
  }

  private transitionTo(phase: Phase): void {
    this.phase = phase;
    this.pathFinder = PathFinding.Air(this.mg);
    if (phase === "patrol") {
      this.fighter.setTargetTile(undefined);
    }
  }

  private moveToward(target: TileRef, moveSpeed: number): void {
    for (let i = 0; i < moveSpeed; i++) {
      const result = this.pathFinder.next(this.fighter.tile(), target);
      if (result.status === PathStatus.NEXT) {
        this.fighter.move(result.node);
      } else {
        break;
      }
    }
  }

  private findEnemyAircraft(range: number): Unit | undefined {
    const owner = this.fighter.owner();
    const nearby = this.mg.nearbyUnits(this.fighter.tile()!, range, AIR_TYPES);
    for (const { unit } of nearby) {
      if (
        unit !== this.fighter &&
        unit.owner() !== owner &&
        owner.canAttackPlayer(unit.owner(), true)
      ) {
        return unit;
      }
    }
    return undefined;
  }

  private randomPatrolTile(center: TileRef = this.homeBaseTile): TileRef {
    const range = 60;
    const mg = this.mg;
    for (let i = 0; i < 50; i++) {
      const x = mg.x(center) + this.random.nextInt(-range / 2, range / 2);
      const y = mg.y(center) + this.random.nextInt(-range / 2, range / 2);
      if (mg.isValidCoord(x, y)) return mg.ref(x, y);
    }
    return center;
  }

  isActive(): boolean {
    return this.fighter?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
