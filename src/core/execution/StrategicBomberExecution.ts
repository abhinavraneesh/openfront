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

// All unit types that warheads can damage on impact tile
const WARHEAD_DAMAGEABLE = [
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
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.Carrier,
  UnitType.TransportShip,
] as const;

// Within this tile distance the payload releases regardless of bomber health
const POINT_OF_NO_RETURN = 2;
// Cluster: 1 centre warhead + this many scatter warheads within SCATTER_RADIUS
const SCATTER_COUNT = 4;
const SCATTER_RADIUS = 3;
// Per-warhead damage (total damage split across warheads)
const WARHEAD_SEARCH_RADIUS = 1; // find units within 1 tile of each warhead landing tile

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
    }
    const info = mg.config().unitInfo(UnitType.StrategicBomber);
    this.maxFuel = info.maxFuel ?? 120;
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

    if (!this.isHomeBaseAlive()) {
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
        this.fuel = this.maxFuel;
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

  private doOutbound(moveSpeed: number, _damage: number): void {
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
    this.phase = "returning";
    this.pathFinder = PathFinding.Air(this.mg);
  }

  /**
   * Scatter cluster: 1 centre warhead + SCATTER_COUNT random warheads within
   * SCATTER_RADIUS tiles. Each warhead damages all enemy units at its landing tile.
   * No tile ownership change, no fallout.
   */
  private releaseCluster(centreTile: TileRef, totalDamage: number): void {
    const owner = this.bomber.owner();
    const warheadCount = 1 + SCATTER_COUNT;
    const damagePerWarhead = Math.round(totalDamage / warheadCount);

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

    // Damage all enemy units at each landing tile
    for (const tile of landingTiles) {
      const nearby = this.mg.nearbyUnits(
        tile,
        WARHEAD_SEARCH_RADIUS,
        WARHEAD_DAMAGEABLE,
      );
      for (const { unit } of nearby) {
        if (
          unit.owner() !== owner &&
          owner.canAttackPlayer(unit.owner(), true) &&
          unit.isActive()
        ) {
          const multiplier = this.mg
            .config()
            .combatMultiplier(UnitType.StrategicBomber, unit.type());
          unit.modifyHealth(-Math.round(damagePerWarhead * multiplier), owner);
        }
      }
    }
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
