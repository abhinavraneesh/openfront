import { Execution, Game, Unit } from "../game/Game";

export class NavalYardExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(private navalYard: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.navalYard.isActive() || this.navalYard.isUnderConstruction()) {
      if (!this.navalYard.isActive()) this.active = false;
      return;
    }

    // Passive income from naval operations
    this.navalYard.owner().addGold(15n);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
