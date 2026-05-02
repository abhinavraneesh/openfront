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

// Submarines prefer high-value capital ships as targets.
const SUBMARINE_PRIORITY_TARGETS: UnitType[] = [
  UnitType.Warship,
  UnitType.Battleship,
  UnitType.Cruiser,
];

export class SubmarineExecution implements Execution {
  private random: PseudoRandom;
  private submarine: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private alreadySentShell = new Set<Unit>();
  private missionRunner: ShipMissionRunner | null = null;

  constructor(
    private input: (UnitParams<UnitType.Submarine> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.submarine = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Submarine,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn Submarine for ${this.input.owner.name()}`,
        );
        return;
      }
      this.submarine = this.input.owner.buildUnit(UnitType.Submarine, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
  }

  tick(ticks: number): void {
    if (!this.submarine?.isActive()) return;
    if (this.submarine.health() <= 0) {
      this.submarine.delete();
      return;
    }

    ensureShipHomePort(this.mg, this.submarine);
    repairShipIfDocked(this.mg, this.submarine);

    if (this.missionRunner === null) {
      const info = this.mg.config().unitInfo(UnitType.Submarine);
      this.missionRunner = new ShipMissionRunner(
        this.submarine,
        this.mg,
        this.pathfinder,
        this.random,
        {
          shipType: UnitType.Submarine,
          baseDamage: Number(info.damage ?? 400),
          attackRate: info.attackRate ?? 20,
          range: info.range ?? 90,
        },
      );
    }
    const result = this.missionRunner.run();

    if (result === "auto") {
      this.submarine.setTargetUnit(this.findTarget());
      this.patrol();
      if (this.submarine.targetUnit() !== undefined) {
        if (this.submarine.targetUnit()!.type() === UnitType.TradeShip) {
          this.huntDownTradeShip();
        } else {
          this.shootTarget();
        }
      }
    } else if (result === "movement") {
      this.submarine.setTargetUnit(this.findTarget());
      if (this.submarine.targetUnit() !== undefined) {
        if (this.submarine.targetUnit()!.type() === UnitType.TradeShip) {
          this.huntDownTradeShip();
        } else {
          this.shootTarget();
        }
      }
    }
  }

  private findTarget(): Unit | undefined {
    const info = this.mg.config().unitInfo(UnitType.Submarine);
    const range = info.range ?? 90;
    const owner = this.submarine.owner();

    const allShipTypes = [
      UnitType.TransportShip,
      UnitType.TradeShip,
      UnitType.Warship,
      UnitType.Destroyer,
      UnitType.Cruiser,
      UnitType.Battleship,
      UnitType.Submarine,
      UnitType.Minelayer,
      UnitType.Carrier,
    ];

    const ships = this.mg.nearbyUnits(
      this.submarine.tile()!,
      range,
      allShipTypes,
    );

    let priorityTarget: Unit | undefined;
    let priorityDist = Infinity;
    let fallbackTarget: Unit | undefined;
    let fallbackDist = Infinity;

    for (const { unit, distSquared } of ships) {
      if (
        unit.owner() === owner ||
        unit === this.submarine ||
        !owner.canAttackPlayer(unit.owner(), true) ||
        this.alreadySentShell.has(unit)
      ) {
        continue;
      }
      if (
        SUBMARINE_PRIORITY_TARGETS.includes(unit.type()) &&
        distSquared < priorityDist
      ) {
        priorityTarget = unit;
        priorityDist = distSquared;
      } else if (priorityTarget === undefined && distSquared < fallbackDist) {
        fallbackTarget = unit;
        fallbackDist = distSquared;
      }
    }
    return priorityTarget ?? fallbackTarget;
  }

  private huntDownTradeShip(): void {
    const target = this.submarine.targetUnit();
    if (!target?.isActive()) {
      this.submarine.setTargetUnit(undefined);
      return;
    }
    const result = this.pathfinder.next(
      this.submarine.tile(),
      target.tile(),
      5,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.submarine.owner().captureUnit(target);
        this.submarine.setTargetUnit(undefined);
        this.submarine.move(this.submarine.tile());
        return;
      case PathStatus.NEXT:
        this.submarine.move(result.node);
        break;
    }
  }

  private shootTarget() {
    const info = this.mg.config().unitInfo(UnitType.Submarine);
    const attackRate = info.attackRate ?? 20;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      const target = this.submarine.targetUnit()!;
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Submarine, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.submarine.tile(),
          this.submarine.owner(),
          this.submarine,
          target,
          Math.round((info.damage ?? 400) * multiplier),
        ),
      );
      if (!target.hasHealth()) {
        this.alreadySentShell.add(target);
        this.submarine.setTargetUnit(undefined);
      }
    }
  }

  private patrol() {
    if (this.submarine.targetTile() === undefined) {
      this.submarine.setTargetTile(this.randomTile());
      if (this.submarine.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.submarine.tile(),
      this.submarine.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.submarine.setTargetTile(undefined);
        this.submarine.move(result.node);
        break;
      case PathStatus.NEXT:
        this.submarine.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.submarine.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const waterComponent = mg.getWaterComponent(this.submarine.tile());
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
        waterComponent !== null &&
        !mg.hasWaterComponent(tile, waterComponent)
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
    return this.submarine?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
