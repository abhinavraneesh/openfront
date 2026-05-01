import { Game, Unit, UnitMission, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
import { MineExecution } from "./MineExecution";
import { ensureShipHomePort } from "./NavalRepair";
import { NavalShellExecution } from "./NavalShellExecution";

// Ship types we may need to look up by id (escort/attack target).
const SHIP_LOOKUP_TYPES: UnitType[] = [
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Minelayer,
  UnitType.Warship,
  UnitType.TransportShip,
  UnitType.TradeShip,
];

// Targetable tile occupants for BOMBARD_COAST.
const BOMBARD_TARGET_TYPES: UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.DefensePost,
  UnitType.Factory,
  UnitType.Airbase,
  UnitType.FuelDepot,
  UnitType.CoastalBattery,
  UnitType.NavalYard,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Minelayer,
  UnitType.Warship,
  UnitType.TransportShip,
];

export function findUnitById(mg: Game, id: number): Unit | undefined {
  for (const u of mg.units(...SHIP_LOOKUP_TYPES)) {
    if (u.id() === id) return u;
  }
  return undefined;
}

export interface MissionRunnerStats {
  shipType: UnitType;
  baseDamage: number;
  attackRate: number;
  range: number;
  // Separate range for BOMBARD_COAST. Defaults to range if omitted.
  bombardRange?: number;
}

/**
 * Tick result for a ship execution.
 *  - "auto": runner did nothing; caller should run its autonomous behavior
 *  - "movement": runner handled movement only; caller may still run its
 *    own combat/utility logic (e.g. shoot autonomously-found targets)
 *  - "full": runner handled both movement AND combat for this tick;
 *    caller should skip its combat logic
 */
export type MissionResult = "auto" | "movement" | "full";

export class ShipMissionRunner {
  private lastAttack = 0;
  private sweepStartTick = -1;
  // Saved last tile of escort target so we can patrol there if target dies.
  private lastEscortTile: TileRef | undefined;

  constructor(
    private ship: Unit,
    private mg: Game,
    private pathfinder: WaterPathFinder,
    private random: PseudoRandom,
    private stats: MissionRunnerStats,
  ) {}

  run(): MissionResult {
    const mission = this.ship.mission();
    switch (mission) {
      case UnitMission.MOVE_TO_TILE:
        return this.runMoveToTile();
      case UnitMission.HOLD_POSITION:
        return this.runHoldPosition();
      case UnitMission.PATROL_AREA:
        return this.runPatrolArea();
      case UnitMission.BOMBARD_COAST:
        return this.runBombardCoast();
      case UnitMission.ESCORT_UNIT:
        return this.runEscortUnit();
      case UnitMission.ATTACK_SHIP:
        return this.runAttackShip();
      case UnitMission.HUNT_SUBMARINE:
        return this.runHuntSubmarine();
      case UnitMission.SWEEP_MINES:
        return this.runSweepMines();
      case UnitMission.LAY_MINE:
        return this.runLayMine();
      case UnitMission.RETURN_TO_PORT:
        return this.runReturnToPort();
      case UnitMission.AUTO:
      case undefined:
        return "auto";
      default:
        // Air-unit missions assigned to a ship — treat as no-op.
        return "auto";
    }
  }

  private runMoveToTile(): MissionResult {
    const target = this.ship.missionTargetTile();
    if (target === undefined) {
      this.clearMission();
      return "auto";
    }
    if (this.mg.manhattanDist(this.ship.tile(), target) === 0) {
      this.ship.setTargetTile(undefined);
      this.ship.setMission(UnitMission.HOLD_POSITION);
      return "movement";
    }
    this.stepToward(target);
    return "movement";
  }

  private runHoldPosition(): MissionResult {
    this.ship.setTargetTile(undefined);
    return "movement";
  }

  private runPatrolArea(): MissionResult {
    const center = this.ship.missionTargetTile();
    if (center === undefined) {
      this.clearMission();
      return "auto";
    }

    const PATROL_RADIUS = 2;
    const owner = this.ship.owner();
    const nearbyEnemies = this.mg.nearbyUnits(
      center,
      PATROL_RADIUS,
      SHIP_LOOKUP_TYPES,
    );
    const isCarrier = this.ship.type() === UnitType.Carrier;

    for (const { unit } of nearbyEnemies) {
      if (unit.owner() === owner) continue;
      if (!unit.isActive()) continue;
      if (!owner.canAttackPlayer(unit.owner(), true)) continue;

      if (isCarrier) {
        // Carriers do NOT auto-engage. They flee to the nearest friendly
        // port. If no port exists, just continue patrolling (no engage).
        const port = this.nearestFriendlyPort();
        if (port !== undefined) {
          this.ship.setMission(UnitMission.MOVE_TO_TILE);
          this.ship.setMissionTargetTile(port);
          this.ship.setMissionTargetUnitId(undefined);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("show-message", {
                detail: {
                  message: "Carrier is under threat — returning to port",
                  duration: 4000,
                  color: "yellow",
                },
              }),
            );
          }
          return this.runMoveToTile();
        }
        // No friendly port — break out of the engage loop, fall through
        // to ordinary patrol movement (no auto-engage for carriers).
        break;
      }

      // Other ships: auto-engage. Keep missionTargetTile (center) so
      // runAttackShip can fall back to patrol when target dies.
      this.ship.setMission(UnitMission.ATTACK_SHIP);
      this.ship.setMissionTargetUnitId(unit.id());
      return this.runAttackShip();
    }

    let target = this.ship.targetTile();
    const arrived =
      target === undefined ||
      this.mg.manhattanDist(this.ship.tile(), target) === 0;
    if (arrived) {
      const next = this.randomTileNear(center, PATROL_RADIUS);
      if (next !== undefined) {
        this.ship.setTargetTile(next);
        target = next;
      }
    }
    if (target !== undefined) {
      this.stepToward(target);
    }
    return "movement";
  }

  private runBombardCoast(): MissionResult {
    const target = this.ship.missionTargetTile();
    if (target === undefined) {
      this.clearMission();
      return "auto";
    }
    const bombRange = this.stats.bombardRange ?? this.stats.range;
    const dist2 = this.mg.euclideanDistSquared(this.ship.tile(), target);
    const inRange = dist2 <= bombRange * bombRange;
    if (!inRange) {
      this.stepToward(target);
      return "movement";
    }
    // In range — bombard every 3 ticks. Find nearest enemy unit near target.
    const BOMBARD_RATE = 3;
    if (this.mg.ticks() - this.lastAttack >= BOMBARD_RATE) {
      this.lastAttack = this.mg.ticks();
      const owner = this.ship.owner();
      const candidates = this.mg.nearbyUnits(target, 4, BOMBARD_TARGET_TYPES);
      let victim: Unit | undefined;
      let bestDist = Infinity;
      for (const { unit, distSquared } of candidates) {
        if (unit.owner() === owner) continue;
        if (!unit.isActive()) continue;
        if (!owner.canAttackPlayer(unit.owner(), true)) continue;
        if (distSquared < bestDist) {
          victim = unit;
          bestDist = distSquared;
        }
      }
      if (victim) {
        const multiplier = this.mg
          .config()
          .combatMultiplier(this.stats.shipType, victim.type());
        this.mg.addExecution(
          new NavalShellExecution(
            this.ship.tile(),
            owner,
            this.ship,
            victim,
            Math.round(this.stats.baseDamage * multiplier),
          ),
        );
      }
    }
    return "full";
  }

  private runEscortUnit(): MissionResult {
    const id = this.ship.missionTargetUnitId();
    if (id === undefined) {
      this.clearMission();
      return "auto";
    }
    const target = findUnitById(this.mg, id);
    if (!target?.isActive()) {
      // Target destroyed — patrol at last known position.
      const fallbackTile = this.lastEscortTile;
      this.ship.setMission(UnitMission.PATROL_AREA);
      this.ship.setMissionTargetTile(fallbackTile);
      this.ship.setMissionTargetUnitId(undefined);
      return "movement";
    }
    this.lastEscortTile = target.tile();
    const dist = this.mg.manhattanDist(this.ship.tile(), target.tile());
    if (dist > 2) {
      this.stepToward(target.tile());
    }
    return "movement";
  }

  private runAttackShip(): MissionResult {
    const id = this.ship.missionTargetUnitId();
    if (id === undefined) {
      this.fallbackToPatrolOrClear();
      return "auto";
    }
    const target = findUnitById(this.mg, id);
    if (!target?.isActive() || !target.hasHealth()) {
      this.fallbackToPatrolOrClear();
      return "auto";
    }
    const range = this.stats.range;
    const dist2 = this.mg.euclideanDistSquared(this.ship.tile(), target.tile());
    if (dist2 > range * range) {
      this.stepToward(target.tile());
      this.ship.setTargetUnit(undefined);
      return "full";
    }
    this.ship.setTargetUnit(target);
    if (this.mg.ticks() - this.lastAttack > this.stats.attackRate) {
      this.lastAttack = this.mg.ticks();
      const multiplier = this.mg
        .config()
        .combatMultiplier(this.stats.shipType, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.ship.tile(),
          this.ship.owner(),
          this.ship,
          target,
          Math.round(this.stats.baseDamage * multiplier),
        ),
      );
    }
    return "full";
  }

  private runHuntSubmarine(): MissionResult {
    // Spec: depth charge every 3 ticks within 3 tiles of target sub.
    const DEPTH_CHARGE_RANGE = 3;
    const DEPTH_CHARGE_RATE = 3;

    const id = this.ship.missionTargetUnitId();
    if (id === undefined) {
      this.fallbackToPatrolOrClear();
      return "auto";
    }
    const target = findUnitById(this.mg, id);
    if (!target?.isActive() || !target.hasHealth()) {
      this.fallbackToPatrolOrClear();
      return "auto";
    }

    const dist2 = this.mg.euclideanDistSquared(this.ship.tile(), target.tile());
    if (dist2 > DEPTH_CHARGE_RANGE * DEPTH_CHARGE_RANGE) {
      this.stepToward(target.tile());
      this.ship.setTargetUnit(undefined);
      return "full";
    }

    this.ship.setTargetUnit(target);
    if (this.mg.ticks() - this.lastAttack >= DEPTH_CHARGE_RATE) {
      this.lastAttack = this.mg.ticks();
      const multiplier = this.mg
        .config()
        .combatMultiplier(this.stats.shipType, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.ship.tile(),
          this.ship.owner(),
          this.ship,
          target,
          Math.round(this.stats.baseDamage * multiplier),
        ),
      );
    }
    return "full";
  }

  private runSweepMines(): MissionResult {
    const target = this.ship.missionTargetTile();
    if (target === undefined) {
      this.clearMission();
      return "auto";
    }
    if (this.mg.manhattanDist(this.ship.tile(), target) > 0) {
      this.stepToward(target);
      return "movement";
    }
    // Arrived — deduct sweep cost (200g) on first tick, then count down 10.
    if (this.sweepStartTick === -1) {
      const SWEEP_COST = 200n;
      const owner = this.ship.owner();
      if (owner.gold() < SWEEP_COST) {
        this.clearMission();
        return "auto";
      }
      owner.removeGold(SWEEP_COST);
      this.sweepStartTick = this.mg.ticks();
    }
    if (this.mg.ticks() - this.sweepStartTick >= 10) {
      const owner = this.ship.owner();
      const nearby = this.mg.nearbyUnits(this.ship.tile(), 2, [UnitType.Mine]);
      for (const { unit } of nearby) {
        if (unit.owner() === owner) continue;
        if (!unit.isActive()) continue;
        unit.delete();
      }
      this.sweepStartTick = -1;
      this.clearMission();
      return "auto";
    }
    return "movement";
  }

  private runLayMine(): MissionResult {
    if (this.ship.type() !== UnitType.Minelayer) {
      this.clearMission();
      return "auto";
    }
    const target = this.ship.missionTargetTile();
    if (target === undefined) {
      this.clearMission();
      return "auto";
    }
    if (this.mg.manhattanDist(this.ship.tile(), target) > 0) {
      this.stepToward(target);
      return "movement";
    }
    this.mg.addExecution(
      new MineExecution(this.ship.owner(), this.ship.tile()),
    );
    this.clearMission();
    return "auto";
  }

  private runReturnToPort(): MissionResult {
    const homePort = ensureShipHomePort(this.mg, this.ship);
    if (homePort === undefined) {
      this.clearMission();
      return "auto";
    }
    const dist = this.mg.manhattanDist(this.ship.tile(), homePort.tile());
    if (dist === 0) {
      // Arrived — transition to HOLD_POSITION so repairShipIfDocked() fires
      // each tick (2 HP/tick at a Naval Yard, passive, no gold cost).
      this.ship.setTargetTile(undefined);
      this.ship.setMission(UnitMission.HOLD_POSITION);
      return "movement";
    }
    this.stepToward(homePort.tile());
    return "full";
  }

  // When a mission resolves (target dead, etc.), fall back to PATROL_AREA
  // around the saved patrol center (missionTargetTile) if one is set —
  // this handles the auto-engage-from-patrol case. Otherwise clear mission.
  private fallbackToPatrolOrClear(): void {
    const patrolCenter = this.ship.missionTargetTile();
    if (patrolCenter !== undefined) {
      this.ship.setMission(UnitMission.PATROL_AREA);
      this.ship.setMissionTargetUnitId(undefined);
      // missionTargetTile already holds the patrol center — leave it.
    } else {
      this.clearMission();
    }
  }

  private nearestFriendlyPort(): TileRef | undefined {
    const ports = this.ship.owner().units(UnitType.Port);
    let nearest: TileRef | undefined;
    let best = Infinity;
    for (const p of ports) {
      if (!p.isActive()) continue;
      const d = this.mg.euclideanDistSquared(this.ship.tile(), p.tile());
      if (d < best) {
        best = d;
        nearest = p.tile();
      }
    }
    return nearest;
  }

  private clearMission() {
    this.ship.setMission(undefined);
    this.ship.setMissionTargetTile(undefined);
    this.ship.setMissionTargetUnitId(undefined);
  }

  private stepToward(target: TileRef): void {
    const result = this.pathfinder.next(this.ship.tile(), target);
    switch (result.status) {
      case PathStatus.COMPLETE:
      case PathStatus.NEXT:
        this.ship.move(result.node);
        break;
    }
  }

  private randomTileNear(center: TileRef, radius: number): TileRef | undefined {
    const mg = this.mg;
    for (let i = 0; i < 50; i++) {
      const x = mg.x(center) + this.random.nextInt(-radius, radius + 1);
      const y = mg.y(center) + this.random.nextInt(-radius, radius + 1);
      if (!mg.isValidCoord(x, y)) continue;
      const tile = mg.ref(x, y);
      if (!mg.isWater(tile)) continue;
      return tile;
    }
    return undefined;
  }
}
