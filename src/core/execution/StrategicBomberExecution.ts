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

type Phase = "finding" | "outbound" | "attacking" | "returning" | "idle";

const BUILDING_TARGETS = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Airbase,
] as const;

export class StrategicBomberExecution implements Execution {
  private bomber: Unit;
  private mg: Game;
  private pathFinder: SteppingPathFinder<TileRef>;
  private random: PseudoRandom;
  private phase: Phase = "finding";
  private fuel = 120;
  private maxFuel = 120;
  private homeBaseTile: TileRef;
  private idleTicks = 0;

  constructor(
    private input: (UnitParams<UnitType.StrategicBomber> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = PathFinding.Air(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.bomber = this.input;
      this.homeBaseTile = this.bomber.patrolTile() ?? this.bomber.tile();
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.StrategicBomber,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn StrategicBomber`);
        return;
      }
      this.homeBaseTile = spawn;
      this.bomber = this.input.owner.buildUnit(
        UnitType.StrategicBomber,
        spawn,
        { ...this.input, patrolTile: spawn },
      );
    }
    const info = mg.config().unitInfo(UnitType.StrategicBomber);
    this.maxFuel = info.maxFuel ?? 120;
    this.fuel = this.maxFuel;
  }

  tick(ticks: number): void {
    if (!this.bomber?.isActive()) return;
    if (this.bomber.health() <= 0) {
      this.bomber.delete();
      return;
    }

    if (!this.isHomeBaseAlive()) {
      this.bomber.delete();
      return;
    }

    const info = this.mg.config().unitInfo(UnitType.StrategicBomber);
    const moveSpeed = info.moveSpeed ?? 1;

    switch (this.phase) {
      case "finding":
        this.doFinding(info.range ?? 120);
        break;
      case "outbound":
        this.fuel--;
        if (this.fuel <= 0) {
          this.bomber.delete();
          return;
        }
        this.checkFuelDepotRefuel();
        this.doOutbound(moveSpeed, info.damage ?? 1500);
        break;
      case "attacking":
        this.doAttack(info.damage ?? 1500);
        break;
      case "returning":
        this.fuel--;
        if (this.fuel <= 0) {
          this.bomber.delete();
          return;
        }
        this.checkFuelDepotRefuel();
        this.doReturn(moveSpeed);
        break;
      case "idle":
        this.idleTicks++;
        if (this.idleTicks > 50) {
          this.idleTicks = 0;
          this.phase = "finding";
        }
        break;
    }
  }

  private isHomeBaseAlive(): boolean {
    const owner = this.bomber.owner();
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
    return owner.units(UnitType.Carrier).some((u) => u.isActive());
  }

  private findNearestCarrier(): Unit | undefined {
    const owner = this.bomber.owner();
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const u of owner.units(UnitType.Carrier)) {
      if (!u.isActive()) continue;
      const d = this.mg.euclideanDistSquared(this.bomber.tile(), u.tile());
      if (d < bestDist) {
        best = u;
        bestDist = d;
      }
    }
    return best;
  }

  private checkFuelDepotRefuel(): void {
    const owner = this.bomber.owner();
    const nearby = this.mg.nearbyUnits(this.bomber.tile(), 5, [
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

  private doFinding(range: number): void {
    const owner = this.bomber.owner();
    const candidates = this.mg.nearbyUnits(
      this.bomber.tile()!,
      range,
      BUILDING_TARGETS,
    );

    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of candidates) {
      if (
        unit.owner() !== owner &&
        owner.canAttackPlayer(unit.owner(), true) &&
        !unit.isUnderConstruction() &&
        distSquared < bestDist
      ) {
        best = unit;
        bestDist = distSquared;
      }
    }

    if (best) {
      this.bomber.setTargetUnit(best);
      this.phase = "outbound";
      this.pathFinder = PathFinding.Air(this.mg);
    }
  }

  private doOutbound(moveSpeed: number, damage: number): void {
    const target = this.bomber.targetUnit();
    if (!target?.isActive()) {
      this.bomber.setTargetUnit(undefined);
      this.phase = "returning";
      this.pathFinder = PathFinding.Air(this.mg);
      return;
    }

    this.moveToward(target.tile(), moveSpeed);

    if (this.mg.manhattanDist(this.bomber.tile(), target.tile()) <= 1) {
      this.phase = "attacking";
    }
  }

  private doAttack(damage: number): void {
    const target = this.bomber.targetUnit();
    if (!target?.isActive()) {
      this.bomber.setTargetUnit(undefined);
      this.phase = "returning";
      this.pathFinder = PathFinding.Air(this.mg);
      return;
    }

    // Cluster payload: damage primary target + splash nearby enemy units
    const CLUSTER_RADIUS = 15;
    const MAX_SPLASH_TARGETS = 5;
    const owner = this.bomber.owner();

    const allNearby = [
      ...this.mg.nearbyUnits(target.tile(), CLUSTER_RADIUS, BUILDING_TARGETS),
      ...this.mg.nearbyUnits(target.tile(), CLUSTER_RADIUS, [
        UnitType.Warship,
        UnitType.Destroyer,
        UnitType.Cruiser,
        UnitType.Battleship,
        UnitType.TransportShip,
        UnitType.TradeShip,
        UnitType.Carrier,
      ]),
    ];

    const splashTargets: Unit[] = [target];
    for (const { unit } of allNearby) {
      if (
        unit !== target &&
        unit.owner() !== owner &&
        owner.canAttackPlayer(unit.owner(), true) &&
        splashTargets.length < MAX_SPLASH_TARGETS
      ) {
        splashTargets.push(unit);
      }
    }

    const damagePerTarget = Math.round(damage / splashTargets.length);
    for (const t of splashTargets) {
      if (t.isActive()) {
        const multiplier = this.mg
          .config()
          .combatMultiplier(UnitType.StrategicBomber, t.type());
        t.modifyHealth(-Math.round(damagePerTarget * multiplier), owner);
      }
    }

    this.bomber.setTargetUnit(undefined);
    this.phase = "returning";
    this.pathFinder = PathFinding.Air(this.mg);
  }

  private doReturn(moveSpeed: number): void {
    const carrier = this.findNearestCarrier();
    const returnTarget = carrier?.tile() ?? this.homeBaseTile;
    this.moveToward(returnTarget, moveSpeed);
    if (this.mg.manhattanDist(this.bomber.tile(), returnTarget) <= 1) {
      this.fuel = this.maxFuel;
      this.bomber.modifyHealth(10);
      this.phase = "idle";
      this.idleTicks = 0;
    }
  }

  private moveToward(target: TileRef, moveSpeed: number): void {
    for (let i = 0; i < moveSpeed; i++) {
      const result = this.pathFinder.next(this.bomber.tile(), target);
      if (result.status === PathStatus.NEXT) {
        this.bomber.move(result.node);
      } else {
        break;
      }
    }
  }

  isActive(): boolean {
    return this.bomber?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
