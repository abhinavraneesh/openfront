import { Execution, Game, Unit, UnitType } from "../game/Game";
import { NavalShellExecution } from "./NavalShellExecution";

const TARGET_TYPES = [
  UnitType.TransportShip,
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.TradeShip,
  UnitType.Carrier,
] as const;

export class CoastalBatteryExecution implements Execution {
  private mg: Game;
  private active = true;
  private lastAttack = 0;

  constructor(private battery: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.battery.isActive() || this.battery.isUnderConstruction()) {
      if (!this.battery.isActive()) this.active = false;
      return;
    }

    if (this.battery.health() <= 0) {
      this.battery.delete();
      this.active = false;
      return;
    }

    const info = this.mg.config().unitInfo(UnitType.CoastalBattery);
    const range = info.range ?? 80;
    const attackRate = info.attackRate ?? 30;
    const damage = info.damage ?? 250;

    if (this.mg.ticks() - this.lastAttack <= attackRate) return;

    const target = this.findTarget(range);
    if (!target) return;

    this.lastAttack = this.mg.ticks();
    const multiplier = this.mg
      .config()
      .combatMultiplier(UnitType.CoastalBattery, target.type());
    this.mg.addExecution(
      new NavalShellExecution(
        this.battery.tile(),
        this.battery.owner(),
        this.battery,
        target,
        Math.round(damage * multiplier),
      ),
    );
  }

  private findTarget(range: number): Unit | undefined {
    const owner = this.battery.owner();
    const nearby = this.mg.nearbyUnits(
      this.battery.tile(),
      range,
      TARGET_TYPES,
    );

    let best: Unit | undefined;
    let bestDist = Infinity;

    for (const { unit, distSquared } of nearby) {
      if (
        unit.owner() === owner ||
        !owner.canAttackPlayer(unit.owner(), true)
      ) {
        continue;
      }
      if (distSquared < bestDist) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
