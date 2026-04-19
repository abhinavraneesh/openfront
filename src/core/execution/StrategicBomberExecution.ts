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
    private input:
      | (UnitParams<UnitType.StrategicBomber> & OwnerComp)
      | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = PathFinding.Air(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.bomber = this.input;
      this.homeBaseTile = this.bomber.patrolTile() ?? this.bomber.tile();
    } else {
      this.homeBaseTile = this.input.patrolTile;
      const spawn = this.input.owner.canBuild(
        UnitType.StrategicBomber,
        this.homeBaseTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn StrategicBomber`);
        return;
      }
      this.bomber = this.input.owner.buildUnit(
        UnitType.StrategicBomber,
        spawn,
        this.input,
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
        if (this.fuel <= 0) { this.bomber.delete(); return; }
        this.doOutbound(moveSpeed, info.damage ?? 1500);
        break;
      case "attacking":
        this.doAttack(info.damage ?? 1500);
        break;
      case "returning":
        this.fuel--;
        if (this.fuel <= 0) { this.bomber.delete(); return; }
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
    const nearby = this.mg.nearbyUnits(this.homeBaseTile, 3, [UnitType.Airbase]);
    return nearby.some(
      ({ unit }) =>
        unit.owner() === this.bomber.owner() &&
        unit.isActive() &&
        !unit.isUnderConstruction(),
    );
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
    if (target?.isActive()) {
      target.modifyHealth(-damage, this.bomber.owner());
    }
    this.bomber.setTargetUnit(undefined);
    this.phase = "returning";
    this.pathFinder = PathFinding.Air(this.mg);
  }

  private doReturn(moveSpeed: number): void {
    this.moveToward(this.homeBaseTile, moveSpeed);
    if (this.mg.manhattanDist(this.bomber.tile(), this.homeBaseTile) <= 1) {
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
