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
import { NavalShellExecution } from "./NavalShellExecution";

export class CruiserExecution implements Execution {
  private random: PseudoRandom;
  private cruiser: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private alreadySentShell = new Set<Unit>();

  constructor(
    private input: (UnitParams<UnitType.Cruiser> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.cruiser = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Cruiser,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn Cruiser for ${this.input.owner.name()}`);
        return;
      }
      this.cruiser = this.input.owner.buildUnit(
        UnitType.Cruiser,
        spawn,
        this.input,
      );
    }
  }

  tick(ticks: number): void {
    if (!this.cruiser?.isActive()) return;
    if (this.cruiser.health() <= 0) {
      this.cruiser.delete();
      return;
    }

    if (this.cruiser.owner().unitCount(UnitType.Port) > 0) {
      this.cruiser.modifyHealth(1);
    }

    this.cruiser.setTargetUnit(this.findTarget());
    this.patrol();

    if (this.cruiser.targetUnit() !== undefined) {
      this.shootTarget();
    }
  }

  private findTarget(): Unit | undefined {
    const info = this.mg.config().unitInfo(UnitType.Cruiser);
    const range = info.range ?? 110;
    const owner = this.cruiser.owner();

    const ships = this.mg.nearbyUnits(
      this.cruiser.tile()!,
      range,
      [
        UnitType.TransportShip,
        UnitType.Warship,
        UnitType.TradeShip,
        UnitType.Destroyer,
        UnitType.Submarine,
        UnitType.Battleship,
        UnitType.Minelayer,
      ],
    );

    let best: Unit | undefined;
    let bestDist = Infinity;

    for (const { unit, distSquared } of ships) {
      if (
        unit.owner() === owner ||
        unit === this.cruiser ||
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
    const info = this.mg.config().unitInfo(UnitType.Cruiser);
    const attackRate = info.attackRate ?? 20;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      this.mg.addExecution(
        new NavalShellExecution(
          this.cruiser.tile(),
          this.cruiser.owner(),
          this.cruiser,
          this.cruiser.targetUnit()!,
          info.damage ?? 200,
        ),
      );
      if (!this.cruiser.targetUnit()!.hasHealth()) {
        this.alreadySentShell.add(this.cruiser.targetUnit()!);
        this.cruiser.setTargetUnit(undefined);
      }
    }
  }

  private patrol() {
    if (this.cruiser.targetTile() === undefined) {
      this.cruiser.setTargetTile(this.randomTile());
      if (this.cruiser.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.cruiser.tile(),
      this.cruiser.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.cruiser.setTargetTile(undefined);
        this.cruiser.move(result.node);
        break;
      case PathStatus.NEXT:
        this.cruiser.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.cruiser.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const warshipComponent = mg.getWaterComponent(this.cruiser.tile());
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
    return this.cruiser?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
