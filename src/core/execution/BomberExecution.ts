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
import { CARRIER_CAPACITY, carrierDockedCount } from "./AircraftRange";

type Phase = "idle" | "outbound" | "attacking" | "returning";

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
  UnitType.DefensePost,
] as const;

export class BomberExecution implements Execution {
  private bomber: Unit;
  private mg: Game;
  private phase: Phase = "idle";
  private homeBaseTile: TileRef;
  private commandedStrikeTile: TileRef | null = null;
  private missionTargetTileSeen: TileRef | null = null;
  private idleTicks = 0;
  private fuel = 0;
  private maxFuel = 0;
  private homeBaseLevel = 1;

  constructor(
    private input: (UnitParams<UnitType.Bomber> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.bomber = this.input;
      this.homeBaseTile = this.bomber.patrolTile() ?? this.bomber.tile();
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Bomber,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn Bomber`);
        return;
      }
      this.homeBaseTile = spawn;
      this.bomber = this.input.owner.buildUnit(UnitType.Bomber, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
      this.bomber.setMission(UnitMission.STAND_DOWN);
      this.phase = "idle";
    }
    const baseFuel = mg.config().unitInfo(UnitType.Bomber).maxFuel ?? 60;
    this.maxFuel = baseFuel * this.homeBaseLevel;
    this.fuel = this.maxFuel;
  }

  tick(ticks: number): void {
    if (!this.bomber?.isActive()) return;
    if (this.bomber.health() <= 0) {
      this.bomber.delete();
      return;
    }

    if (!this.updateHomeBase()) {
      this.bomber.delete();
      return;
    }

    const info = this.mg.config().unitInfo(UnitType.Bomber);
    const moveSpeed = info.moveSpeed ?? 3;
    const mission = this.bomber.mission();
    const dockedAtBase =
      this.mg.manhattanDist(this.bomber.tile(), this.homeBaseTile) <= 1;

    if (mission === UnitMission.STAND_DOWN) {
      this.bomber.setTargetUnit(undefined);
      this.commandedStrikeTile = null;
      this.missionTargetTileSeen = null;
      if (dockedAtBase) {
        this.fuel = Math.min(this.maxFuel, this.fuel + 5);
        if (this.bomber.tile() !== this.homeBaseTile) {
          this.bomber.move(this.homeBaseTile);
        }
        this.bomber.setPatrolTile(this.homeBaseTile);
        this.phase = "idle";
        this.idleTicks = 0;
      } else {
        this.fuel--;
        if (this.fuel <= 0) {
          this.bomber.delete();
          return;
        }
        this.moveStraightToward(this.homeBaseTile, moveSpeed);
      }
      return;
    }

    if (mission === UnitMission.STRIKE_TARGET) {
      const tile = this.bomber.missionTargetTile();
      if (tile !== undefined && tile !== this.missionTargetTileSeen) {
        this.missionTargetTileSeen = tile;
        this.commandedStrikeTile = tile;
        const target = this.findTargetNearTile(tile, 8);
        if (target) this.bomber.setTargetUnit(target);
        else this.bomber.setTargetUnit(undefined);
        this.phase = "outbound";
      }
    }

    switch (this.phase) {
      case "idle":
        if (dockedAtBase) {
          this.fuel = Math.min(this.maxFuel, this.fuel + 5);
          if (this.bomber.tile() !== this.homeBaseTile) {
            this.bomber.move(this.homeBaseTile);
          }
          this.bomber.setPatrolTile(this.homeBaseTile);
        }
        this.idleTicks++;
        if (this.idleTicks > 30) {
          this.idleTicks = 0;
          // Auto-find target only within safe operating range.
          const safeRange = this.safeOneWayRange(moveSpeed);
          if (safeRange > 0) {
            const autoTarget = this.findTargetNearTile(
              this.bomber.tile(),
              safeRange,
            );
            if (autoTarget) {
              this.bomber.setTargetUnit(autoTarget);
              this.phase = "outbound";
            }
          }
        }
        break;

      case "outbound":
        this.fuel--;
        if (this.fuel <= 0) {
          this.bomber.delete();
          return;
        }
        // Abort sortie if not enough fuel to return.
        if (this.shouldReturnHome(moveSpeed)) {
          this.bomber.setTargetUnit(undefined);
          this.commandedStrikeTile = null;
          this.missionTargetTileSeen = null;
          this.bomber.setMission(UnitMission.STAND_DOWN);
          this.bomber.setMissionTargetTile(undefined);
          this.phase = "returning";
          break;
        }
        this.doOutbound(moveSpeed, info.damage ?? 800);
        break;

      case "attacking":
        this.doAttack(info.damage ?? 800);
        break;

      case "returning":
        this.fuel--;
        if (this.fuel <= 0) {
          this.bomber.delete();
          return;
        }
        this.moveStraightToward(this.homeBaseTile, moveSpeed);
        if (dockedAtBase) {
          this.fuel = this.maxFuel;
          this.bomber.modifyHealth(10);
          this.bomber.setPatrolTile(this.homeBaseTile);
          this.phase = "idle";
          this.idleTicks = 0;
        }
        break;
    }
  }

  private shouldReturnHome(moveSpeed: number): boolean {
    const dist = this.mg.manhattanDist(this.bomber.tile(), this.homeBaseTile);
    const ticksHome = Math.ceil(dist / moveSpeed);
    return this.fuel < ticksHome * 2 + 8;
  }

  private safeOneWayRange(moveSpeed: number): number {
    return Math.max(0, Math.floor((this.fuel - 8) / 2) * moveSpeed);
  }

  private updateHomeBase(): boolean {
    const owner = this.bomber.owner();
    const here = this.bomber.tile();
    let best: TileRef | undefined;
    let bestLevel = 1;
    let bestDist = Infinity;

    for (const u of owner.units(UnitType.Airbase)) {
      if (!u.isActive() || u.isUnderConstruction()) continue;
      const d = this.mg.euclideanDistSquared(here, u.tile());
      if (d < bestDist) {
        best = u.tile();
        bestLevel = u.level();
        bestDist = d;
      }
    }
    for (const u of owner.units(UnitType.Carrier)) {
      if (!u.isActive()) continue;
      if (
        u.tile() !== this.bomber.tile() &&
        carrierDockedCount(u) >= CARRIER_CAPACITY
      )
        continue;
      const d = this.mg.euclideanDistSquared(here, u.tile());
      if (d < bestDist) {
        best = u.tile();
        bestLevel = 1; // carriers are always level 1
        bestDist = d;
      }
    }

    if (best === undefined) return false;
    this.homeBaseTile = best;
    if (bestLevel !== this.homeBaseLevel) {
      const baseFuel = this.mg.config().unitInfo(UnitType.Bomber).maxFuel ?? 60;
      this.homeBaseLevel = bestLevel;
      this.maxFuel = baseFuel * bestLevel;
    }
    return true;
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
    let target = this.bomber.targetUnit();

    if (this.commandedStrikeTile !== null) {
      if (!target?.isActive()) {
        target = this.findTargetNearTile(this.commandedStrikeTile, 8);
        if (target) this.bomber.setTargetUnit(target);
      }
      const flyTo = target?.tile() ?? this.commandedStrikeTile;
      this.moveStraightToward(flyTo, moveSpeed);
      if (this.mg.manhattanDist(this.bomber.tile(), flyTo) <= 1) {
        this.phase = "attacking";
      }
      return;
    }

    if (!target?.isActive()) {
      this.bomber.setTargetUnit(undefined);
      this.phase = "returning";
      return;
    }

    this.moveStraightToward(target.tile(), moveSpeed);
    if (this.mg.manhattanDist(this.bomber.tile(), target.tile()) <= 1) {
      this.phase = "attacking";
    }
  }

  private doAttack(damage: number): void {
    let target = this.bomber.targetUnit();

    if (this.commandedStrikeTile !== null && !target?.isActive()) {
      target = this.findTargetNearTile(this.commandedStrikeTile, 4);
    }

    if (target?.isActive()) {
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Bomber, target.type());
      target.modifyHealth(
        -Math.round(damage * multiplier),
        this.bomber.owner(),
      );
    }

    this.bomber.setTargetUnit(undefined);
    this.commandedStrikeTile = null;
    this.missionTargetTileSeen = null;
    this.bomber.setMission(UnitMission.STAND_DOWN);
    this.bomber.setMissionTargetTile(undefined);
    this.phase = "returning";
  }

  // Move one step per tick toward target using Chebyshev (diagonal) steps — no pathfinding.
  private moveStraightToward(target: TileRef, moveSpeed: number): void {
    let cur = this.bomber.tile();
    for (let i = 0; i < moveSpeed; i++) {
      const cx = this.mg.x(cur);
      const cy = this.mg.y(cur);
      const tx = this.mg.x(target);
      const ty = this.mg.y(target);
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx === 0 && dy === 0) break;
      const nx = cx + Math.sign(dx);
      const ny = cy + Math.sign(dy);
      if (!this.mg.isValidCoord(nx, ny)) break;
      const next = this.mg.ref(nx, ny);
      this.bomber.move(next);
      cur = next;
    }
  }

  isActive(): boolean {
    return this.bomber?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
