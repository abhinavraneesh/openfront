import { Execution, Game, Player, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

export class NavalShellExecution implements Execution {
  private active = true;
  private pathFinder: SteppingPathFinder<TileRef>;
  private shell: Unit | undefined;
  private mg: Game;
  private destroyAtTick: number = -1;
  private random: PseudoRandom;

  constructor(
    private spawn: TileRef,
    private _owner: Player,
    private ownerUnit: Unit,
    private target: Unit,
    private baseDamage: number,
  ) {}

  init(mg: Game, ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(ticks: number): void {
    this.shell ??= this._owner.buildUnit(UnitType.Shell, this.spawn, {});
    if (!this.shell.isActive()) {
      this.active = false;
      return;
    }
    if (
      !this.target.isActive() ||
      this.target.owner() === this.shell.owner() ||
      (this.destroyAtTick !== -1 && this.mg.ticks() >= this.destroyAtTick)
    ) {
      this.shell.delete(false);
      this.active = false;
      return;
    }

    if (this.destroyAtTick === -1 && !this.ownerUnit.isActive()) {
      this.destroyAtTick = this.mg.ticks() + this.mg.config().shellLifetime();
    }

    for (let i = 0; i < 3; i++) {
      const result = this.pathFinder.next(
        this.shell.tile(),
        this.target.tile(),
      );
      if (result.status === PathStatus.COMPLETE) {
        this.active = false;
        this.target.modifyHealth(-this.effectOnTarget(), this._owner);
        this.shell.setReachedTarget();
        this.shell.delete(false);
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.shell.move(result.node);
      }
    }
  }

  private effectOnTarget(): number {
    const roll = this.random.nextInt(1, 6);
    const damageMultiplier = (roll - 1) * 25 + 200;
    const rawDamage = Math.round((this.baseDamage / 250) * damageMultiplier);
    const armor = this.mg.config().unitInfo(this.target.type()).armor ?? 1.0;
    return Math.round(rawDamage * armor);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
