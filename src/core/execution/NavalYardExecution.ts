import { Execution, Game, Unit, UnitType } from "../game/Game";

const HEAL_RANGE = 30;
const NAVAL_TYPES = [
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.Carrier,
] as const;

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

    const owner = this.navalYard.owner();

    // Passive income from naval operations
    owner.addGold(15n);

    const nearby = this.mg.nearbyUnits(
      this.navalYard.tile(),
      HEAL_RANGE,
      NAVAL_TYPES,
    );
    for (const { unit } of nearby) {
      if (unit.owner() === owner && unit.isActive()) {
        unit.modifyHealth(1);
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
