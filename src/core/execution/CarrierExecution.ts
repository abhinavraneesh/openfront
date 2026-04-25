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
import { ShipMissionRunner } from "./ShipMissionRunner";

export class CarrierExecution implements Execution {
  private carrier: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private random: PseudoRandom;
  private missionRunner: ShipMissionRunner | null = null;

  constructor(
    private input: (UnitParams<UnitType.Carrier> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.carrier = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Carrier,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn Carrier for ${this.input.owner.name()}`);
        return;
      }
      this.carrier = this.input.owner.buildUnit(
        UnitType.Carrier,
        spawn,
        this.input,
      );
    }
  }

  tick(_ticks: number): void {
    if (!this.carrier?.isActive()) return;
    if (this.carrier.health() <= 0) {
      this.carrier.delete();
      return;
    }

    // Heal slightly if owner has a NavalYard (handled by NavalYardExecution)
    this.missionRunner ??= new ShipMissionRunner(
      this.carrier,
      this.mg,
      this.pathfinder,
      this.random,
      {
        shipType: UnitType.Carrier,
        baseDamage: 0, // Carriers don't shoot
        attackRate: 999,
        range: 1,
      },
    );
    const result = this.missionRunner.run();
    if (result === "auto") {
      this.patrol();
    }
  }

  private patrol(): void {
    if (this.carrier.targetTile() === undefined) {
      const tile = this.randomTile();
      if (tile !== undefined) this.carrier.setTargetTile(tile);
    }
    if (this.carrier.targetTile() === undefined) return;

    const result = this.pathfinder.next(
      this.carrier.tile(),
      this.carrier.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.carrier.setTargetTile(undefined);
        this.carrier.move(result.node);
        break;
      case PathStatus.NEXT:
        this.carrier.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.carrier.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const waterComponent = mg.getWaterComponent(this.carrier.tile());
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
    return this.carrier?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
