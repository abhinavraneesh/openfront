import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Player,
  Unit,
  UnitMission,
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

// Targets the ATTACK_TILE mission can engage near the chosen tile.
const ATTACK_TILE_TARGETS = [
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.CoastalBattery,
  UnitType.Factory,
  UnitType.City,
  UnitType.Port,
  UnitType.Airbase,
  UnitType.NavalYard,
] as const;

// CAS_NATION: troops removed from target nation per attack tick.
const CAS_TROOP_DAMAGE = 3000;
// How often (ticks) to re-sample the shared border anchor tile.
const CAS_ANCHOR_TTL = 25;
// Radius around the border anchor to search for enemy DefensePosts.
const CAS_DEFENSE_POST_RANGE = 25;
// Patrol wander radius around the anchor tile (tiles).
const CAS_PATROL_RANGE = 20;

export class AttackHelicopterExecution implements Execution {
  private heli: Unit;
  private mg: Game;
  private pathFinder: SteppingPathFinder<TileRef>;
  private random: PseudoRandom;
  private homeBaseTile: TileRef;
  private lastAttack = 0;
  private lastTroopDamage = 0;
  private casAnchorTile: TileRef | null = null;
  private casAnchorAge = 0;

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
      // Newly built helicopters start stood down — player must issue a mission.
      this.heli.setMission(UnitMission.STAND_DOWN);
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
    const mission = this.heli.mission();

    // STAND_DOWN: drop target, return home, idle.
    if (mission === UnitMission.STAND_DOWN) {
      this.heli.setTargetUnit(undefined);
      const dist = this.mg.manhattanDist(this.heli.tile(), this.homeBaseTile);
      if (dist > 1) {
        this.moveToward(this.homeBaseTile, moveSpeed);
      }
      return;
    }

    // ATTACK_TILE: fly to commanded tile and engage anything there.
    if (mission === UnitMission.ATTACK_TILE) {
      const tile = this.heli.missionTargetTile();
      if (tile !== undefined) {
        const target = this.findTargetNearTile(tile, 6);
        if (target) {
          this.engageTarget(target, moveSpeed, attackRate, damage);
        } else {
          this.moveToward(tile, moveSpeed);
        }
        return;
      }
    }

    // CAS_NATION: patrol the shared border, destroy DefensePosts, drain troops.
    if (mission === UnitMission.CAS_NATION) {
      const nationId = this.heli.missionTargetUnitId();
      if (nationId !== undefined) {
        const nation = this.mg.playerBySmallID(nationId);
        if (nation?.isPlayer()) {
          this.doCASNation(nation as Player, moveSpeed, attackRate, damage);
          return;
        }
      }
    }

    // Default autonomous behavior.
    const target = this.findTarget(range);
    if (target) {
      this.engageTarget(target, moveSpeed, attackRate, damage);
    } else {
      this.heli.setTargetUnit(undefined);
      this.patrol(moveSpeed);
    }
  }

  private engageTarget(
    target: Unit,
    moveSpeed: number,
    attackRate: number,
    damage: number,
  ): void {
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
      target.modifyHealth(-Math.round(damage * multiplier), this.heli.owner());
    }
  }

  private findTargetNearTile(tile: TileRef, range: number): Unit | undefined {
    const owner = this.heli.owner();
    const nearby = this.mg.nearbyUnits(tile, range, ATTACK_TILE_TARGETS);
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of nearby) {
      if (
        unit.owner() !== owner &&
        owner.canAttackPlayer(unit.owner(), true) &&
        distSquared < bestDist
      ) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  private doCASNation(
    nation: Player,
    moveSpeed: number,
    attackRate: number,
    damage: number,
  ): void {
    // Refresh border anchor periodically so the heli drifts along the whole front.
    if (this.casAnchorTile === null || ++this.casAnchorAge >= CAS_ANCHOR_TTL) {
      this.casAnchorTile = this.findSharedBorderAnchor(nation);
      this.casAnchorAge = 0;
    }

    const anchor = this.casAnchorTile;
    if (anchor === null) {
      // No shared border yet — sit tight near home.
      this.patrol(moveSpeed);
    } else {
      const target = this.findDefensePostNear(nation, anchor);
      if (target) {
        this.engageTarget(target, moveSpeed, attackRate, damage);
      } else {
        this.patrolNearAnchor(anchor, moveSpeed);
      }
    }

    // Direct troop drain — fires on the attack cadence regardless of whether
    // there is a DefensePost target, so the heli hurts them even in the open.
    if (this.mg.ticks() - this.lastTroopDamage > attackRate) {
      this.lastTroopDamage = this.mg.ticks();
      (nation as Player).removeTroops(CAS_TROOP_DAMAGE);
    }
  }

  // Iterate up to 500 of our own border tiles and return one that is adjacent
  // to the target nation's territory, chosen at random from the matches found.
  private findSharedBorderAnchor(nation: Player): TileRef | null {
    const owner = this.heli.owner();
    const shared: TileRef[] = [];
    let checked = 0;
    for (const tile of owner.borderTiles()) {
      if (++checked > 500) break;
      for (const neighbor of this.mg.neighbors(tile)) {
        if (this.mg.owner(neighbor) === nation) {
          shared.push(tile);
          break;
        }
      }
    }
    if (shared.length === 0) return null;
    return shared[this.random.nextInt(0, shared.length - 1)];
  }

  private findDefensePostNear(
    nation: Player,
    anchor: TileRef,
  ): Unit | undefined {
    const nearby = this.mg.nearbyUnits(anchor, CAS_DEFENSE_POST_RANGE, [
      UnitType.DefensePost,
    ]);
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of nearby) {
      if (
        unit.owner() === nation &&
        !unit.isUnderConstruction() &&
        distSquared < bestDist
      ) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  private patrolNearAnchor(anchor: TileRef, moveSpeed: number): void {
    if (this.heli.targetTile() === undefined) {
      this.heli.setTargetTile(
        CASUtils.randomPatrolTile(
          this.mg,
          anchor,
          this.random,
          CAS_PATROL_RANGE,
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
