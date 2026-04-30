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
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
import { ensureShipHomePort, repairShipIfDocked } from "./NavalRepair";
import { NavalShellExecution } from "./NavalShellExecution";
import { ShipMissionRunner } from "./ShipMissionRunner";

export class BattleshipExecution implements Execution {
  private random: PseudoRandom;
  private battleship: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private alreadySentShell = new Set<Unit>();
  private missionRunner: ShipMissionRunner | null = null;

  constructor(
    private input: (UnitParams<UnitType.Battleship> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.battleship = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Battleship,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn Battleship for ${this.input.owner.name()}`,
        );
        return;
      }
      this.battleship = this.input.owner.buildUnit(UnitType.Battleship, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
  }

  tick(ticks: number): void {
    if (!this.battleship?.isActive()) return;
    if (this.battleship.health() <= 0) {
      this.battleship.delete();
      return;
    }

    ensureShipHomePort(this.mg, this.battleship);
    repairShipIfDocked(this.mg, this.battleship);

    if (this.missionRunner === null) {
      const info = this.mg.config().unitInfo(UnitType.Battleship);
      this.missionRunner = new ShipMissionRunner(
        this.battleship,
        this.mg,
        this.pathfinder,
        this.random,
        {
          shipType: UnitType.Battleship,
          baseDamage: Number(info.damage ?? 400),
          attackRate: info.attackRate ?? 25,
          range: info.range ?? 150,
        },
      );
    }
    const result = this.missionRunner.run();

    if (result === "auto") {
      this.battleship.setTargetUnit(this.findTarget());
      this.patrol();
      if (this.battleship.targetUnit() !== undefined) {
        this.shootTarget();
      }
    } else if (result === "movement") {
      this.battleship.setTargetUnit(this.findTarget());
      if (this.battleship.targetUnit() !== undefined) {
        this.shootTarget();
      }
    }
  }

  private findTarget(): Unit | undefined {
    const config = this.mg.config();
    const info = config.unitInfo(UnitType.Battleship);
    const range = info.range ?? 150;
    const owner = this.battleship.owner();

    const navalTargets = this.mg.nearbyUnits(this.battleship.tile()!, range, [
      UnitType.TransportShip,
      UnitType.TradeShip,
      UnitType.Warship,
      UnitType.Destroyer,
      UnitType.Cruiser,
      UnitType.Battleship,
      UnitType.Submarine,
      UnitType.Minelayer,
      UnitType.Carrier,
    ]);

    let best: Unit | undefined;
    let bestDist = Infinity;

    for (const { unit, distSquared } of navalTargets) {
      if (
        unit.owner() === owner ||
        unit === this.battleship ||
        !owner.canAttackPlayer(unit.owner(), true) ||
        this.alreadySentShell.has(unit)
      ) {
        continue;
      }
      if (distSquared < bestDist) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  private shootTarget() {
    const info = this.mg.config().unitInfo(UnitType.Battleship);
    const attackRate = info.attackRate ?? 25;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      const target = this.battleship.targetUnit()!;
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Battleship, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.battleship.tile(),
          this.battleship.owner(),
          this.battleship,
          target,
          Math.round((info.damage ?? 400) * multiplier),
        ),
      );
      if (!target.hasHealth()) {
        this.alreadySentShell.add(target);
        this.battleship.setTargetUnit(undefined);
      }
    }
  }

  private patrol() {
    if (this.battleship.targetTile() === undefined) {
      this.battleship.setTargetTile(this.randomTile());
      if (this.battleship.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.battleship.tile(),
      this.battleship.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.battleship.setTargetTile(undefined);
        this.battleship.move(result.node);
        break;
      case PathStatus.NEXT:
        this.battleship.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.battleship.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const warshipComponent = mg.getWaterComponent(this.battleship.tile());
    const maxAttempts = 500;
    let attempts = 0;
    let expandCount = 0;

    while (expandCount < 3) {
      const x =
        mg.x(patrolTile) +
        this.random.nextInt(-patrolRange / 2, patrolRange / 2);
      const y =
        mg.y(patrolTile) +
        this.random.nextInt(-patrolRange / 2, patrolRange / 2);
      if (!mg.isValidCoord(x, y)) continue;
      const tile = mg.ref(x, y);
      if (!mg.isWater(tile) || (!allowShoreline && mg.isShoreline(tile))) {
        if (++attempts >= maxAttempts) {
          expandCount++;
          attempts = 0;
          patrolRange += Math.floor(patrolRange / 2);
        }
        continue;
      }
      if (
        warshipComponent !== null &&
        !mg.hasWaterComponent(tile, warshipComponent)
      ) {
        if (++attempts >= maxAttempts) {
          expandCount++;
          attempts = 0;
          patrolRange += Math.floor(patrolRange / 2);
        }
        continue;
      }
      return tile;
    }
    if (!allowShoreline) return this.randomTile(true);
    return undefined;
  }

  isActive(): boolean {
    return this.battleship?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
