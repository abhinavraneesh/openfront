import { Execution, Game, Unit } from "../game/Game";

export class FuelDepotExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(private fuelDepot: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.fuelDepot.isActive()) {
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
