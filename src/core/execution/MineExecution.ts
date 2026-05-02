import {
  Execution,
  Game,
  MessageType,
  Player,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";

const MINE_LIFETIME = 300;
const TRIGGER_RANGE = 2;

const NAVAL_TYPES = [
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.Carrier,
  UnitType.TransportShip,
  UnitType.TradeShip,
] as const;

export class MineExecution implements Execution {
  private mine: Unit;
  private mg: Game;
  private active = true;
  private ticksAlive = 0;

  constructor(
    private owner: Player,
    private tile: TileRef,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    this.mine = this.owner.buildUnit(UnitType.Mine, this.tile, {});
  }

  tick(_ticks: number): void {
    if (!this.mine?.isActive()) {
      this.active = false;
      return;
    }

    this.ticksAlive++;
    if (this.ticksAlive >= MINE_LIFETIME) {
      this.mine.delete();
      this.active = false;
      return;
    }

    const target = this.findTarget();
    if (target) {
      this.detonate(target);
    }
  }

  private findTarget(): Unit | undefined {
    const owner = this.owner;
    const nearby = this.mg.nearbyUnits(
      this.mine.tile(),
      TRIGGER_RANGE,
      NAVAL_TYPES,
    );
    for (const { unit } of nearby) {
      if (unit.owner() !== owner && owner.canAttackPlayer(unit.owner(), true)) {
        return unit;
      }
    }
    return undefined;
  }

  private detonate(target: Unit): void {
    const damage = this.mg.config().unitInfo(UnitType.Mine).damage ?? 400;
    target.modifyHealth(-damage, this.owner);
    this.mine.setReachedTarget(); // flags detonation so FxLayer plays explosion
    const tx = Math.round(this.mg.x(target.tile()));
    const ty = Math.round(this.mg.y(target.tile()));
    this.mg.displayMessage(
      `${target.type()} hit a mine near (${tx}, ${ty})`,
      MessageType.UNIT_DESTROYED,
      target.owner().id(),
    );
    this.mine.delete();
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
