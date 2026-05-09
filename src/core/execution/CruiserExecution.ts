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
import { ensureShipHomePort, repairShipIfDocked } from "./NavalRepair";
import { NavalShellExecution } from "./NavalShellExecution";
import { ShipMissionRunner } from "./ShipMissionRunner";

export class CruiserExecution implements Execution {
  private random: PseudoRandom;
  private cruiser: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private lastAAAttack = 0;
  private alreadySentShell = new Set<Unit>();
  private missionRunner: ShipMissionRunner | null = null;

  constructor(
    private input: (UnitParams<UnitType.Cruiser> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.cruiser = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Cruiser,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(`Failed to spawn Cruiser for ${this.input.owner.name()}`);
        return;
      }
      this.cruiser = this.input.owner.buildUnit(UnitType.Cruiser, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
  }

  tick(ticks: number): void {
    if (!this.cruiser?.isActive()) return;
    if (this.cruiser.health() <= 0) {
      this.cruiser.delete();
      return;
    }

    ensureShipHomePort(this.mg, this.cruiser);
    repairShipIfDocked(this.mg, this.cruiser);

    if (this.missionRunner === null) {
      const info = this.mg.config().unitInfo(UnitType.Cruiser);
      this.missionRunner = new ShipMissionRunner(
        this.cruiser,
        this.mg,
        this.pathfinder,
        this.random,
        {
          shipType: UnitType.Cruiser,
          baseDamage: Number(info.damage ?? 200),
          attackRate: info.attackRate ?? 20,
          range: info.range ?? 110,
        },
      );
    }
    const result = this.missionRunner.run();

    if (result === "auto") {
      this.cruiser.setTargetUnit(this.findTarget());
      this.patrol();
      if (this.cruiser.targetUnit() !== undefined) {
        if (this.cruiser.targetUnit()!.type() === UnitType.TradeShip) {
          this.huntDownTradeShip();
        } else {
          this.shootTarget();
        }
      }
    } else if (result === "movement") {
      this.cruiser.setTargetUnit(this.findTarget());
      if (this.cruiser.targetUnit() !== undefined) {
        if (this.cruiser.targetUnit()!.type() === UnitType.TradeShip) {
          this.huntDownTradeShip();
        } else {
          this.shootTarget();
        }
      }
    }
    // AA always fires (point-defense).
    this.fireAA();
  }

  private findTarget(): Unit | undefined {
    const config = this.mg.config();
    const info = config.unitInfo(UnitType.Cruiser);
    const range = info.range ?? 110;
    const owner = this.cruiser.owner();

    const navalTargets = this.mg.nearbyUnits(this.cruiser.tile()!, range, [
      UnitType.TransportShip,
      UnitType.TradeShip,
      UnitType.Warship,
      UnitType.Destroyer,
      UnitType.Cruiser,
      UnitType.Battleship,
      UnitType.Submarine,
      UnitType.Minelayer,
      UnitType.Carrier,
    ]);

    let best: Unit | undefined;
    let bestDist = Infinity;

    for (const { unit, distSquared } of navalTargets) {
      if (
        unit.owner() === owner ||
        unit === this.cruiser ||
        !owner.canAttackPlayer(unit.owner(), true) ||
        this.alreadySentShell.has(unit)
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

  private huntDownTradeShip(): void {
    const target = this.cruiser.targetUnit();
    if (!target?.isActive()) {
      this.cruiser.setTargetUnit(undefined);
      return;
    }
    const result = this.pathfinder.next(this.cruiser.tile(), target.tile(), 5);
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.cruiser.owner().captureUnit(target);
        this.cruiser.setTargetUnit(undefined);
        this.cruiser.move(this.cruiser.tile());
        return;
      case PathStatus.NEXT:
        this.cruiser.move(result.node);
        break;
    }
  }

  private shootTarget() {
    const info = this.mg.config().unitInfo(UnitType.Cruiser);
    const attackRate = info.attackRate ?? 20;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      const target = this.cruiser.targetUnit()!;
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Cruiser, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.cruiser.tile(),
          this.cruiser.owner(),
          this.cruiser,
          target,
          Math.round((info.damage ?? 200) * multiplier),
        ),
      );
      if (!target.hasHealth()) {
        this.alreadySentShell.add(target);
        this.cruiser.setTargetUnit(undefined);
      }
    }
  }

  private fireAA(): void {
    const AA_RANGE = 4;
    const AA_RATE = 2;
    const AA_DAMAGE = 80;
    if (this.mg.ticks() - this.lastAAAttack <= AA_RATE) return;

    const owner = this.cruiser.owner();
    const airUnits = this.mg.nearbyUnits(this.cruiser.tile()!, AA_RANGE, [
      UnitType.Fighter,
      UnitType.Bomber,
      UnitType.AttackHelicopter,
    ]);

    for (const { unit } of airUnits) {
      if (unit.owner() !== owner && owner.canAttackPlayer(unit.owner(), true)) {
        this.lastAAAttack = this.mg.ticks();
        const multiplier = this.mg
          .config()
          .combatMultiplier(UnitType.Cruiser, unit.type());
        this.mg.addExecution(
          new NavalShellExecution(
            this.cruiser.tile(),
            this.cruiser.owner(),
            this.cruiser,
            unit,
            Math.round(AA_DAMAGE * multiplier),
          ),
        );
        return;
      }
    }
  }

  private patrol() {
    if (this.cruiser.targetTile() === undefined) {
      this.cruiser.setTargetTile(this.randomTile());
      if (this.cruiser.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.cruiser.tile(),
      this.cruiser.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.cruiser.setTargetTile(undefined);
        this.cruiser.move(result.node);
        break;
      case PathStatus.NEXT:
        this.cruiser.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.cruiser.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const warshipComponent = mg.getWaterComponent(this.cruiser.tile());
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
        warshipComponent !== null &&
        !mg.hasWaterComponent(tile, warshipComponent)
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
    return this.cruiser?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
