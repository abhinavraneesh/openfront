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

    this.fuel--;
    if (this.fuel <= 0) {
      this.fighter.delete();
      return;
    }

    this.checkFuelDepotRefuel();

    if (!this.isHomeBaseAlive()) {
      this.fuel = 0;
      return;
    }

    const info = this.mg.config().unitInfo(UnitType.Fighter);
    const moveSpeed = info.moveSpeed ?? 4;

    switch (this.phase) {
      case "patrol":
        this.doPatrol(
          moveSpeed,
          info.range ?? 50,
          info.attackRate ?? 8,
          info.damage ?? 200,
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

  private isHomeBaseAlive(): boolean {
    const owner = this.fighter.owner();
    const nearAirbase = this.mg.nearbyUnits(this.homeBaseTile, 3, [
      UnitType.Airbase,
    ]);
    if (
      nearAirbase.some(
        ({ unit }) =>
          unit.owner() === owner &&
          unit.isActive() &&
          !unit.isUnderConstruction(),
      )
    ) {
      return true;
    }
    // Also count a Carrier as a valid home base
    return owner.units(UnitType.Carrier).some((u) => u.isActive());
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
  ): void {
    if (this.shouldReturnHome(moveSpeed)) {
      this.transitionTo("returning");
      return;
    }

    const target = this.findEnemyAircraft(range);
    if (target) {
      this.fighter.setTargetUnit(target);
      this.transitionTo("intercept");
      return;
    }

    if (this.fighter.targetTile() === undefined) {
      this.fighter.setTargetTile(this.randomPatrolTile());
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
      target.modifyHealth(-damage, this.fighter.owner());
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

  private randomPatrolTile(): TileRef {
    const range = 60;
    const mg = this.mg;
    for (let i = 0; i < 50; i++) {
      const x =
        mg.x(this.homeBaseTile) + this.random.nextInt(-range / 2, range / 2);
      const y =
        mg.y(this.homeBaseTile) + this.random.nextInt(-range / 2, range / 2);
      if (mg.isValidCoord(x, y)) return mg.ref(x, y);
    }
    return this.homeBaseTile;
  }

  isActive(): boolean {
    return this.fighter?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
