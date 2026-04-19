import { Execution, Game, Player } from "../game/Game";

export class SetWorkerRatioExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private ratio: number,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(_mg: Game, _ticks: number): void {
    this.player.setWorkerRatio(this.ratio);
    this.active = false;
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }
}
