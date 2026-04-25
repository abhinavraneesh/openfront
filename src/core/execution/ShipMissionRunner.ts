import { Game, Unit, UnitMission, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
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
  // Shared "last attack" counter so the runner's own combat respects the
  // ship's attackRate. Caller passes a ref so the runner can mutate it
  // without needing a callback.
  private lastAttack = 0;

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
      case UnitMission.PATROL_AREA:
        return this.runPatrolArea();
      case UnitMission.BOMBARD_COAST:
        return this.runBombardCoast();
      case UnitMission.ESCORT_UNIT:
        return this.runEscortUnit();
      case UnitMission.ATTACK_SHIP:
        return this.runAttackShip();
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
      // Arrived — hold position, suppress combat patrol but allow opportunistic shooting
      this.ship.setTargetTile(undefined);
      return "movement";
    }
    this.stepToward(target);
    return "movement";
  }

  private runPatrolArea(): MissionResult {
    const center = this.ship.missionTargetTile();
    if (center === undefined) {
      this.clearMission();
      return "auto";
    }
    let target = this.ship.targetTile();
    const arrived =
      target === undefined ||
      this.mg.manhattanDist(this.ship.tile(), target) === 0;
    if (arrived) {
      const next = this.randomTileNear(center, 2);
      if (next !== undefined) {
        this.ship.setTargetTile(next);
        target = next;
      }
    }
    if (target !== undefined) {
      this.stepToward(target);
    }
    // Combat is allowed — ships defend themselves while patrolling.
    return "movement";
  }

  private runBombardCoast(): MissionResult {
    const target = this.ship.missionTargetTile();
    if (target === undefined) {
      this.clearMission();
      return "auto";
    }
    const dist2 = this.mg.euclideanDistSquared(this.ship.tile(), target);
    const range = this.stats.range;
    const inRange = dist2 <= range * range;
    if (!inRange) {
      this.stepToward(target);
      return "movement";
    }
    // In range — bombard. Find any enemy unit on/near the target tile.
    if (this.mg.ticks() - this.lastAttack > this.stats.attackRate) {
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
      this.clearMission();
      return "auto";
    }
    const dist = this.mg.manhattanDist(this.ship.tile(), target.tile());
    if (dist > 2) {
      this.stepToward(target.tile());
    }
    // Escorts still defend themselves — allow autonomous combat.
    return "movement";
  }

  private runAttackShip(): MissionResult {
    const id = this.ship.missionTargetUnitId();
    if (id === undefined) {
      this.clearMission();
      return "auto";
    }
    const target = findUnitById(this.mg, id);
    if (!target?.isActive() || !target.hasHealth()) {
      this.clearMission();
      return "auto";
    }
    const range = this.stats.range;
    const dist2 = this.mg.euclideanDistSquared(this.ship.tile(), target.tile());
    if (dist2 > range * range) {
      this.stepToward(target.tile());
      this.ship.setTargetUnit(undefined);
      return "full";
    }
    // In range — engage.
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

  private runReturnToPort(): MissionResult {
    const owner = this.ship.owner();
    const ports = owner.units(UnitType.Port);
    if (ports.length === 0) {
      // No port to return to — fall back to autonomous behavior.
      this.clearMission();
      return "auto";
    }
    let nearest: Unit | undefined;
    let best = Infinity;
    for (const p of ports) {
      if (!p.isActive()) continue;
      const d = this.mg.euclideanDistSquared(this.ship.tile(), p.tile());
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    if (!nearest) {
      this.clearMission();
      return "auto";
    }
    const dist = this.mg.manhattanDist(this.ship.tile(), nearest.tile());
    if (dist <= 2) {
      // Docked — heal to full and resume autonomous patrol.
      const info = this.mg.config().unitInfo(this.stats.shipType);
      const maxHp = Number(info.maxHealth ?? 100);
      const heal = Math.max(0, maxHp - this.ship.health());
      if (heal > 0) this.ship.modifyHealth(heal);
      this.clearMission();
      return "auto";
    }
    this.stepToward(nearest.tile());
    return "full";
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
