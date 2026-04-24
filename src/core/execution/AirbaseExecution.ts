import { Execution, Game, Unit, UnitType } from "../game/Game";
import { navalIncomeMultiplier } from "./PortExecution";

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

    // Airbase logistics income: scales with city count and worker ratio
    const owner = this.airbase.owner();
    const cities = owner.unitCount(UnitType.City);
    const bonus = Math.floor(cities / 3) * 3;
    if (bonus > 0) {
      const multiplier = navalIncomeMultiplier(owner.workerRatio());
      owner.addGold(BigInt(Math.round(bonus * multiplier)));
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
