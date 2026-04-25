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

type Phase = "finding" | "outbound" | "attacking" | "returning" | "idle";

// Precision strike: buildings and ships only — never troops
const STRIKE_TARGETS = [
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.Carrier,
  UnitType.TransportShip,
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Airbase,
  UnitType.NavalYard,
  UnitType.CoastalBattery,
  UnitType.FuelDepot,
  UnitType.DefensePost,
] as const;

export class TacticalBomberExecution implements Execution {
  private bomber: Unit;
  private mg: Game;
  private pathFinder: SteppingPathFinder<TileRef>;
  private random: PseudoRandom;
  private phase: Phase = "finding";
  private fuel = 60;
  private maxFuel = 60;
  private homeBaseTile: TileRef;
  private idleTicks = 0;
  private stuckTicks = 0;
  private lastTile: TileRef | null = null;
  private missionTargetTileSeen: TileRef | null = null;

  constructor(
    private input: (UnitParams<UnitType.TacticalBomber> & OwnerComp) | Unit,
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
        UnitType.TacticalBomber,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn TacticalBomber`);
        return;
      }
      this.homeBaseTile = spawn;
      this.bomber = this.input.owner.buildUnit(UnitType.TacticalBomber, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
    const info = mg.config().unitInfo(UnitType.TacticalBomber);
    this.maxFuel = info.maxFuel ?? 60;
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

    const info = this.mg.config().unitInfo(UnitType.TacticalBomber);
    const moveSpeed = info.moveSpeed ?? 2;
    const mission = this.bomber.mission();

    // STAND_DOWN: drop target, return home, refuse new strikes.
    if (mission === UnitMission.STAND_DOWN) {
      const docked =
        this.mg.manhattanDist(this.bomber.tile(), this.homeBaseTile) <= 1;
      if (docked) {
        this.fuel = this.maxFuel;
        this.phase = "idle";
        this.idleTicks = 0;
        return;
      }
      this.bomber.setTargetUnit(undefined);
      this.fuel--;
      if (this.fuel <= 0) {
        this.bomber.delete();
        return;
      }
      this.checkFuelDepotRefuel();
      this.doReturn(moveSpeed);
      return;
    }

    // STRIKE_TARGET: accept commanded mission tile; pick a target near it.
    if (mission === UnitMission.STRIKE_TARGET) {
      const tile = this.bomber.missionTargetTile();
      if (tile !== undefined && tile !== this.missionTargetTileSeen) {
        this.missionTargetTileSeen = tile;
        const target = this.findTargetNearTile(tile, 8);
        if (target) {
          this.bomber.setTargetUnit(target);
          this.phase = "outbound";
          this.pathFinder = PathFinding.Air(this.mg);
          this.stuckTicks = 0;
          this.lastTile = null;
        }
      }
    }

    switch (this.phase) {
      case "finding":
        this.doFinding(info.range ?? 80);
        break;
      case "outbound":
        this.fuel--;
        if (this.fuel <= 0) {
          this.bomber.delete();
          return;
        }
        this.checkFuelDepotRefuel();
        this.doOutbound(moveSpeed, info.damage ?? 600);
        break;
      case "attacking":
        this.doAttack(info.damage ?? 600);
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
        if (this.idleTicks > 30) {
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
    const best = this.findTargetNearTile(this.bomber.tile()!, range);
    if (best) {
      this.bomber.setTargetUnit(best);
      this.phase = "outbound";
      this.pathFinder = PathFinding.Air(this.mg);
      this.stuckTicks = 0;
      this.lastTile = null;
    }
  }

  private findTargetNearTile(near: TileRef, range: number): Unit | undefined {
    const owner = this.bomber.owner();
    const candidates = this.mg.nearbyUnits(near, range, STRIKE_TARGETS);
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
    return best;
  }

  private doOutbound(moveSpeed: number, _damage: number): void {
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
    if (target?.isActive()) {
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.TacticalBomber, target.type());
      target.modifyHealth(
        -Math.round(damage * multiplier),
        this.bomber.owner(),
      );
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
    // Pathfinding-stuck guard: if we haven't moved for many ticks, abort
    // outbound mission so we don't drain fuel until crash.
    const cur = this.bomber.tile();
    if (this.lastTile !== null && this.lastTile === cur) {
      this.stuckTicks++;
      if (this.stuckTicks > 12) {
        this.stuckTicks = 0;
        this.lastTile = null;
        this.bomber.setTargetUnit(undefined);
        this.phase = "returning";
        this.pathFinder = PathFinding.Air(this.mg);
        return;
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastTile = cur;
  }

  isActive(): boolean {
    return this.bomber?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
