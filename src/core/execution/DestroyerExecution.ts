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

export class DestroyerExecution implements Execution {
  private random: PseudoRandom;
  private destroyer: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private alreadySentShell = new Set<Unit>();

  constructor(
    private input: (UnitParams<UnitType.Destroyer> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.destroyer = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Destroyer,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn Destroyer for ${this.input.owner.name()}`,
        );
        return;
      }
      this.destroyer = this.input.owner.buildUnit(
        UnitType.Destroyer,
        spawn,
        this.input,
      );
    }
  }

  tick(ticks: number): void {
    if (!this.destroyer?.isActive()) return;
    if (this.destroyer.health() <= 0) {
      this.destroyer.delete();
      return;
    }

    if (this.destroyer.owner().unitCount(UnitType.Port) > 0) {
      this.destroyer.modifyHealth(1);
    }

    this.destroyer.setTargetUnit(this.findTarget());
    this.patrol();

    if (this.destroyer.targetUnit() !== undefined) {
      this.shootTarget();
    }
  }

  private findTarget(): Unit | undefined {
    const config = this.mg.config();
    const info = config.unitInfo(UnitType.Destroyer);
    const range = info.range ?? 100;
    const owner = this.destroyer.owner();

    const ships = this.mg.nearbyUnits(this.destroyer.tile()!, range, [
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

    for (const { unit, distSquared } of ships) {
      if (
        unit.owner() === owner ||
        unit === this.destroyer ||
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
    const info = this.mg.config().unitInfo(UnitType.Destroyer);
    const attackRate = info.attackRate ?? 15;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      this.mg.addExecution(
        new NavalShellExecution(
          this.destroyer.tile(),
          this.destroyer.owner(),
          this.destroyer,
          this.destroyer.targetUnit()!,
          info.damage ?? 120,
        ),
      );
      if (!this.destroyer.targetUnit()!.hasHealth()) {
        this.alreadySentShell.add(this.destroyer.targetUnit()!);
        this.destroyer.setTargetUnit(undefined);
      }
    }
  }

  private patrol() {
    if (this.destroyer.targetTile() === undefined) {
      this.destroyer.setTargetTile(this.randomTile());
      if (this.destroyer.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.destroyer.tile(),
      this.destroyer.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.destroyer.setTargetTile(undefined);
        this.destroyer.move(result.node);
        break;
      case PathStatus.NEXT:
        this.destroyer.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.destroyer.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const warshipComponent = mg.getWaterComponent(this.destroyer.tile());
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
    return this.destroyer?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
