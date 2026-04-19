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

// Minelayer: no combat, patrols water. Mine-laying mechanics deferred to future phase.
export class MinelayerExecution implements Execution {
  private random: PseudoRandom;
  private minelayer: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;

  constructor(
    private input: (UnitParams<UnitType.Minelayer> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.minelayer = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Minelayer,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn Minelayer for ${this.input.owner.name()}`,
        );
        return;
      }
      this.minelayer = this.input.owner.buildUnit(
        UnitType.Minelayer,
        spawn,
        this.input,
      );
    }
  }

  tick(ticks: number): void {
    if (!this.minelayer?.isActive()) return;
    if (this.minelayer.health() <= 0) {
      this.minelayer.delete();
      return;
    }

    if (this.minelayer.owner().unitCount(UnitType.Port) > 0) {
      this.minelayer.modifyHealth(1);
    }

    this.patrol();
  }

  private patrol() {
    if (this.minelayer.targetTile() === undefined) {
      this.minelayer.setTargetTile(this.randomTile());
      if (this.minelayer.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.minelayer.tile(),
      this.minelayer.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.minelayer.setTargetTile(undefined);
        this.minelayer.move(result.node);
        break;
      case PathStatus.NEXT:
        this.minelayer.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.minelayer.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const waterComponent = mg.getWaterComponent(this.minelayer.tile());
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
    return this.minelayer?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
