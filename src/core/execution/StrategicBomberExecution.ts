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
import {
  airbaseRangeMultiplier,
  CARRIER_CAPACITY,
  carrierDockedCount,
} from "./AircraftRange";
import { ClusterBombExecution } from "./ClusterBombExecution";

type Phase = "finding" | "outbound" | "attacking" | "returning" | "idle";

// Strategic bomber hunts high-value buildings as primary target selection
const PRIMARY_TARGETS = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Airbase,
  UnitType.NavalYard,
  UnitType.CoastalBattery,
] as const;

// Within this tile distance the payload releases regardless of bomber health
const POINT_OF_NO_RETURN = 2;
// Cluster: 1 centre warhead + this many scatter warheads within SCATTER_RADIUS
const SCATTER_COUNT = 4;
const SCATTER_RADIUS = 3;

export class StrategicBomberExecution implements Execution {
  private bomber: Unit;
  private mg: Game;
  private pathFinder: SteppingPathFinder<TileRef>;
  private random: PseudoRandom;
  private phase: Phase = "finding";
  private fuel = 120;
  private maxFuel = 120;
  private homeBaseTile: TileRef;
  // Level of the airbase this bomber currently treats as home. Carriers and
  // freshly-built airbases are level 1; upgraded airbases multiply the
  // effective fuel tank — and therefore strike radius.
  private homeBaseLevel = 1;
  private idleTicks = 0;
  // Set when bomber enters point-of-no-return; payload fires even if shot down
  private payloadArmed = false;
  private armedTargetTile: TileRef | null = null;
  private stuckTicks = 0;
  private lastTile: TileRef | null = null;
  private missionTargetTileSeen: TileRef | null = null;
  // Tile to bomb when on CLUSTER_STRIKE without a unit target (area strike).
  private commandedStrikeTile: TileRef | null = null;

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
      // Newly built bombers start stood down — player must issue a mission.
      this.bomber.setMission(UnitMission.STAND_DOWN);
      this.phase = "idle";
    }
    const info = mg.config().unitInfo(UnitType.StrategicBomber);
    const baseFuel = info.maxFuel ?? 200;
    const mult = airbaseRangeMultiplier(this.bomber.owner());
    this.maxFuel = Math.round(baseFuel * mult);
    this.fuel = this.maxFuel;
  }

  tick(ticks: number): void {
    if (!this.bomber?.isActive()) return;

    if (this.bomber.health() <= 0) {
      // If payload is armed, release it before the bomber is destroyed
      if (this.payloadArmed && this.armedTargetTile !== null) {
        const info = this.mg.config().unitInfo(UnitType.StrategicBomber);
        this.releaseCluster(this.armedTargetTile, info.damage ?? 1500);
      }
      this.bomber.delete();
      return;
    }

    // Find nearest live friendly airbase/carrier; only delete if none exist.
    if (!this.updateHomeBase()) {
      this.bomber.delete();
      return;
    }

    const info = this.mg.config().unitInfo(UnitType.StrategicBomber);
    const moveSpeed = info.moveSpeed ?? 1;
    const mission = this.bomber.mission();

    if (mission === UnitMission.STAND_DOWN) {
      const docked =
        this.mg.manhattanDist(this.bomber.tile(), this.homeBaseTile) <= 1;
      if (docked) {
        this.fuel = this.maxFuel * this.homeBaseLevel;
        this.phase = "idle";
        this.idleTicks = 0;
        return;
      }
      this.bomber.setTargetUnit(undefined);
      this.payloadArmed = false;
      this.armedTargetTile = null;
      this.commandedStrikeTile = null;
      this.fuel--;
      if (this.fuel <= 0) {
        this.bomber.delete();
        return;
      }
      this.checkFuelDepotRefuel();
      this.doReturn(moveSpeed);
      return;
    }

    // CLUSTER_STRIKE: fly to commanded tile and bomb it (area strike).
    if (mission === UnitMission.CLUSTER_STRIKE) {
      const tile = this.bomber.missionTargetTile();
      if (tile !== undefined && tile !== this.missionTargetTileSeen) {
        this.missionTargetTileSeen = tile;
        this.commandedStrikeTile = tile;
        this.bomber.setTargetUnit(undefined);
        this.phase = "outbound";
        this.pathFinder = PathFinding.Air(this.mg);
        this.stuckTicks = 0;
        this.lastTile = null;
      }
    }

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
        // Stick with carrier deck while idle (don't fall off when it moves)
        if (
          this.mg.manhattanDist(this.bomber.tile(), this.homeBaseTile) <= 1 &&
          this.bomber.tile() !== this.homeBaseTile
        ) {
          this.bomber.move(this.homeBaseTile);
          this.bomber.setPatrolTile(this.homeBaseTile);
        }
        this.idleTicks++;
        if (
          this.idleTicks > 50 &&
          this.bomber.mission() !== UnitMission.STAND_DOWN
        ) {
          this.idleTicks = 0;
          this.phase = "finding";
        }
        break;
    }
  }

  /**
   * Find the nearest live friendly airbase or carrier and update homeBaseTile.
   * Returns false only when no friendly airbase or carrier exists anywhere.
   */
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
        bestLevel = 1;
        bestDist = d;
      }
    }

    if (best === undefined) return false;
    this.homeBaseTile = best;
    this.homeBaseLevel = bestLevel;
    return true;
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
        this.fuel = Math.min(this.fuel + 20, this.maxFuel * this.homeBaseLevel);
        break;
      }
    }
  }

  private doFinding(range: number): void {
    const owner = this.bomber.owner();
    const candidates = this.mg.nearbyUnits(
      this.bomber.tile()!,
      range,
      PRIMARY_TARGETS,
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

  /**
   * Bingo-fuel check: returns true if continuing outbound would risk
   * not having enough fuel to make it home. Once payload is armed
   * (point-of-no-return), the strike commits regardless and the bomber
   * accepts the loss if it can't make it back.
   */
  private shouldReturnHome(moveSpeed: number): boolean {
    if (this.payloadArmed) return false;
    const distHome = this.mg.manhattanDist(
      this.bomber.tile(),
      this.homeBaseTile,
    );
    // Pad for pathfinding detours (1.4x straight line) plus landing reserve.
    const ticksHome = Math.ceil(distHome / moveSpeed);
    return this.fuel <= Math.ceil(ticksHome * 1.4) + 12;
  }

  private doOutbound(moveSpeed: number, _damage: number): void {
    // Bingo-fuel: abort outbound so the bomber actually makes it home
    // alive instead of dying mid-flight when chasing far targets. The
    // payload-armed check above keeps committed strikes committed.
    if (this.shouldReturnHome(moveSpeed)) {
      this.bomber.setTargetUnit(undefined);
      this.commandedStrikeTile = null;
      this.missionTargetTileSeen = null;
      this.phase = "returning";
      this.pathFinder = PathFinding.Air(this.mg);
      return;
    }

    // CLUSTER_STRIKE: pure tile bombing, no unit target required.
    if (this.commandedStrikeTile !== null) {
      const tile = this.commandedStrikeTile;
      const dist = this.mg.manhattanDist(this.bomber.tile(), tile);
      if (dist <= POINT_OF_NO_RETURN && !this.payloadArmed) {
        this.payloadArmed = true;
        this.armedTargetTile = tile;
      }
      this.moveToward(tile, moveSpeed);
      if (dist <= 1) {
        this.phase = "attacking";
      }
      return;
    }

    const target = this.bomber.targetUnit();
    if (!target?.isActive()) {
      this.bomber.setTargetUnit(undefined);
      this.payloadArmed = false;
      this.armedTargetTile = null;
      this.phase = "returning";
      this.pathFinder = PathFinding.Air(this.mg);
      return;
    }

    // Arm payload once within point-of-no-return distance
    const dist = this.mg.manhattanDist(this.bomber.tile(), target.tile());
    if (dist <= POINT_OF_NO_RETURN && !this.payloadArmed) {
      this.payloadArmed = true;
      this.armedTargetTile = target.tile();
    }

    this.moveToward(target.tile(), moveSpeed);

    if (dist <= 1) {
      this.phase = "attacking";
    }
  }

  private doAttack(damage: number): void {
    const target = this.bomber.targetUnit();
    const targetTile =
      this.commandedStrikeTile ?? target?.tile() ?? this.armedTargetTile;
    if (targetTile !== null && targetTile !== undefined) {
      this.releaseCluster(targetTile, damage);
    }
    this.bomber.setTargetUnit(undefined);
    this.payloadArmed = false;
    this.armedTargetTile = null;
    this.commandedStrikeTile = null;
    this.missionTargetTileSeen = null;
    // Clear the player-issued mission so the panel reflects "Idle" rather
    // than holding "Cluster mission" forever, and so re-issuing CLUSTER_STRIKE
    // on the same tile triggers a fresh strike instead of being deduped.
    this.bomber.setMission(undefined);
    this.bomber.setMissionTargetTile(undefined);
    this.phase = "returning";
    this.pathFinder = PathFinding.Air(this.mg);
  }

  /**
   * Scatter cluster: 1 centre warhead + SCATTER_COUNT random warheads within
   * SCATTER_RADIUS tiles. Each warhead is spawned as a `ClusterBombExecution`
   * so it visually flies from the bomber to its landing tile and detonates
   * (showing the FX-layer MiniExplosion) before applying damage.
   *
   * No tile ownership change, no fallout.
   */
  private releaseCluster(centreTile: TileRef, totalDamage: number): void {
    const owner = this.bomber.owner();
    const warheadCount = 1 + SCATTER_COUNT;
    const damagePerWarhead = Math.round(totalDamage / warheadCount);
    const spawnTile = this.bomber.tile();

    // Build list of landing tiles: centre first, then scatter
    const landingTiles: TileRef[] = [centreTile];
    const cx = this.mg.x(centreTile);
    const cy = this.mg.y(centreTile);
    for (let i = 0; i < SCATTER_COUNT; i++) {
      const dx = this.random.nextInt(-SCATTER_RADIUS, SCATTER_RADIUS + 1);
      const dy = this.random.nextInt(-SCATTER_RADIUS, SCATTER_RADIUS + 1);
      const nx = cx + dx;
      const ny = cy + dy;
      if (this.mg.isValidCoord(nx, ny)) {
        landingTiles.push(this.mg.ref(nx, ny));
      }
    }

    for (const tile of landingTiles) {
      this.mg.addExecution(
        new ClusterBombExecution(spawnTile, owner, tile, damagePerWarhead),
      );
    }
  }

  private doReturn(moveSpeed: number): void {
    // Always head for the closest active base. homeBaseTile is already the
    // nearest of any airbase or carrier, so use it directly rather than
    // unconditionally preferring a possibly-far carrier.
    const returnTarget = this.homeBaseTile;
    this.moveToward(returnTarget, moveSpeed);
    if (this.mg.manhattanDist(this.bomber.tile(), returnTarget) <= 1) {
      this.fuel = this.maxFuel;
      this.bomber.modifyHealth(10);
      // Re-anchor patrol reference to current home so the airbase panel can
      // still track this bomber after a carrier moves.
      this.bomber.setPatrolTile(returnTarget);
      this.homeBaseTile = returnTarget;
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
    const cur = this.bomber.tile();
    if (this.lastTile !== null && this.lastTile === cur) {
      this.stuckTicks++;
      if (this.stuckTicks > 12) {
        this.stuckTicks = 0;
        this.lastTile = null;
        this.bomber.setTargetUnit(undefined);
        this.commandedStrikeTile = null;
        this.payloadArmed = false;
        this.armedTargetTile = null;
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
