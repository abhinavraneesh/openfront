import { Game, Unit, UnitMission, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
import { MineExecution } from "./MineExecution";
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

// Enemy ship types detectable in patrol radius.
const PATROL_ENEMY_TYPES: UnitType[] = [
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Minelayer,
  UnitType.Warship,
  UnitType.TransportShip,
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

const SWEEP_COST = 50_000n;
const SWEEP_RADIUS = 2;
const SWEEP_DURATION = 10; // ticks stationary before mines are removed

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
  private sweepStartTick = -1;

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
      // Arrived — transition to HOLD_POSITION.
      this.ship.setMission(UnitMission.HOLD_POSITION);
      this.ship.setMissionTargetTile(undefined);
      return "movement";
    }
    this.stepToward(target);
    return "movement";
  }

  private runHoldPosition(): MissionResult {
    // Stay on current tile. Caller's combat logic fires at enemies in range.
    // No movement, no auto-engage (unlike PATROL_AREA).
    return "movement";
  }

  private runPatrolArea(): MissionResult {
    const center = this.ship.missionTargetTile();
    if (center === undefined) {
      this.clearMission();
      return "auto";
    }

    // Auto-engage: switch to ATTACK_SHIP if an enemy enters patrol radius.
    const enemy = this.findEnemyInRadius(center, SWEEP_RADIUS);
    if (enemy !== undefined) {
      this.ship.setMission(UnitMission.ATTACK_SHIP);
      this.ship.setMissionTargetUnitId(enemy.id());
      // Keep missionTargetTile as the patrol center so we can return to it.
      return this.runAttackShip();
    }

    let target = this.ship.targetTile();
    const arrived =
      target === undefined ||
      this.mg.manhattanDist(this.ship.tile(), target) === 0;
    if (arrived) {
      const next = this.randomTileNear(center, SWEEP_RADIUS);
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
      this.resumePatrolAtCurrentTile();
      return "movement";
    }
    const target = findUnitById(this.mg, id);
    if (!target?.isActive()) {
      // Target destroyed — return to patrol at last position.
      this.resumePatrolAtCurrentTile();
      return "movement";
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
      this.resumePatrolAtCurrentTile();
      return "movement";
    }
    const target = findUnitById(this.mg, id);
    if (!target?.isActive() || !target.hasHealth()) {
      // Target sunk — resume patrol at current tile.
      this.resumePatrolAtCurrentTile();
      return "movement";
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

  private runHuntSubmarine(): MissionResult {
    const id = this.ship.missionTargetUnitId();
    if (id === undefined) {
      this.resumePatrolAtCurrentTile();
      return "movement";
    }
    const target = findUnitById(this.mg, id);
    if (
      !target?.isActive() ||
      !target.hasHealth() ||
      target.type() !== UnitType.Submarine
    ) {
      this.resumePatrolAtCurrentTile();
      return "movement";
    }
    // Always pursue — don't break off. ASW depth charges are fired by the
    // calling Destroyer execution independently (fireASW runs every tick).
    const range = this.stats.range;
    const dist2 = this.mg.euclideanDistSquared(this.ship.tile(), target.tile());
    if (dist2 > range * range) {
      this.stepToward(target.tile());
      return "full";
    }
    this.ship.setTargetUnit(target);
    if (this.mg.ticks() - this.lastAttack > this.stats.attackRate) {
      this.lastAttack = this.mg.ticks();
      const multiplier = this.mg
        .config()
        .combatMultiplier(this.stats.shipType, UnitType.Submarine);
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

    const arrived = this.mg.manhattanDist(this.ship.tile(), target) === 0;
    if (!arrived) {
      this.sweepStartTick = -1;
      this.stepToward(target);
      return "full";
    }

    // Arrived at sweep tile — charge gold on first tick, then wait.
    if (this.sweepStartTick === -1) {
      const owner = this.ship.owner();
      if (owner.gold() < SWEEP_COST) {
        // Can't afford — abort.
        this.clearMission();
        return "auto";
      }
      owner.removeGold(SWEEP_COST);
      this.sweepStartTick = this.mg.ticks();
    }

    if (this.mg.ticks() - this.sweepStartTick < SWEEP_DURATION) {
      return "full"; // Stationary, sweeping.
    }

    // Sweep complete — delete all mines within radius.
    const nearbyMines = this.mg.nearbyUnits(target, SWEEP_RADIUS, [
      UnitType.Mine,
    ]);
    for (const { unit } of nearbyMines) {
      if (unit.isActive()) {
        unit.delete();
      }
    }
    this.sweepStartTick = -1;
    this.clearMission();
    return "full";
  }

  private runLayMine(): MissionResult {
    const target = this.ship.missionTargetTile();
    if (target === undefined) {
      this.clearMission();
      return "auto";
    }
    if (this.mg.manhattanDist(this.ship.tile(), target) !== 0) {
      this.stepToward(target);
      return "full";
    }
    // Arrived — place mine and clear mission.
    this.mg.addExecution(new MineExecution(this.ship.owner(), target));
    this.clearMission();
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
      // Docked — clear mission (repair is handled by NavalYardExecution).
      this.clearMission();
      return "auto";
    }
    this.stepToward(nearest.tile());
    return "full";
  }

  // When a mission target is gone, switch back to PATROL_AREA around the
  // ship's current tile so it doesn't become idle.
  private resumePatrolAtCurrentTile(): void {
    this.ship.setMission(UnitMission.PATROL_AREA);
    this.ship.setMissionTargetTile(this.ship.tile());
    this.ship.setMissionTargetUnitId(undefined);
  }

  private clearMission() {
    this.ship.setMission(undefined);
    this.ship.setMissionTargetTile(undefined);
    this.ship.setMissionTargetUnitId(undefined);
  }

  private findEnemyInRadius(center: TileRef, radius: number): Unit | undefined {
    const owner = this.ship.owner();
    const nearby = this.mg.nearbyUnits(center, radius, PATROL_ENEMY_TYPES);
    for (const { unit } of nearby) {
      if (
        unit.owner() !== owner &&
        unit !== this.ship &&
        unit.isActive() &&
        owner.canAttackPlayer(unit.owner(), true)
      ) {
        return unit;
      }
    }
    return undefined;
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
