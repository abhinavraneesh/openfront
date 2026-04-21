import { Execution, Game, Unit } from "../game/Game";

export class AirbaseExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(private airbase: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.airbase.isActive()) {
      this.active = false;
      return;
    }
    if (this.airbase.isUnderConstruction()) return;

    // Passive income from air operations
    this.airbase.owner().addGold(10n);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
