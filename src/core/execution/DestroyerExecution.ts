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

export class DestroyerExecution implements Execution {
  private random: PseudoRandom;
  private destroyer: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private lastASWAttack = 0;
  private alreadySentShell = new Set<Unit>();
  private missionRunner: ShipMissionRunner | null = null;

  constructor(
    private input: (UnitParams<UnitType.Destroyer> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.destroyer = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Destroyer,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn Destroyer for ${this.input.owner.name()}`,
        );
        return;
      }
      this.destroyer = this.input.owner.buildUnit(UnitType.Destroyer, spawn, {
        ...this.input,
        patrolTile: spawn,
      });
    }
  }

  tick(ticks: number): void {
    if (!this.destroyer?.isActive()) return;
    if (this.destroyer.health() <= 0) {
      this.destroyer.delete();
      return;
    }

    ensureShipHomePort(this.mg, this.destroyer);
    repairShipIfDocked(this.mg, this.destroyer);

    if (this.missionRunner === null) {
      const info = this.mg.config().unitInfo(UnitType.Destroyer);
      this.missionRunner = new ShipMissionRunner(
        this.destroyer,
        this.mg,
        this.pathfinder,
        this.random,
        {
          shipType: UnitType.Destroyer,
          baseDamage: Number(info.damage ?? 120),
          attackRate: info.attackRate ?? 15,
          range: info.range ?? 100,
        },
      );
    }
    const result = this.missionRunner.run();

    if (result === "auto") {
      this.destroyer.setTargetUnit(this.findTarget());
      this.patrol();
      if (this.destroyer.targetUnit() !== undefined) {
        this.shootTarget();
      }
    } else if (result === "movement") {
      // Mission handled movement; allow opportunistic combat.
      this.destroyer.setTargetUnit(this.findTarget());
      if (this.destroyer.targetUnit() !== undefined) {
        this.shootTarget();
      }
    }
    // "full" — mission handled both, but ASW still fires (point-defense).
    this.fireASW();
  }

  private findTarget(): Unit | undefined {
    const config = this.mg.config();
    const info = config.unitInfo(UnitType.Destroyer);
    const range = info.range ?? 100;
    const owner = this.destroyer.owner();

    const navalTargets = this.mg.nearbyUnits(this.destroyer.tile()!, range, [
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
        unit === this.destroyer ||
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

  private fireASW(): void {
    const ASW_RANGE = 3;
    const ASW_RATE = 3;
    if (this.mg.ticks() - this.lastASWAttack <= ASW_RATE) return;

    const owner = this.destroyer.owner();
    const subs = this.mg.nearbyUnits(this.destroyer.tile()!, ASW_RANGE, [
      UnitType.Submarine,
    ]);

    for (const { unit } of subs) {
      if (unit.owner() !== owner && owner.canAttackPlayer(unit.owner(), true)) {
        this.lastASWAttack = this.mg.ticks();
        const info = this.mg.config().unitInfo(UnitType.Destroyer);
        const multiplier = this.mg
          .config()
          .combatMultiplier(UnitType.Destroyer, UnitType.Submarine);
        this.mg.addExecution(
          new NavalShellExecution(
            this.destroyer.tile(),
            owner,
            this.destroyer,
            unit,
            Math.round((info.damage ?? 150) * multiplier),
          ),
        );
        return;
      }
    }
  }

  private shootTarget() {
    const info = this.mg.config().unitInfo(UnitType.Destroyer);
    const attackRate = info.attackRate ?? 15;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      const target = this.destroyer.targetUnit()!;
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Destroyer, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.destroyer.tile(),
          this.destroyer.owner(),
          this.destroyer,
          target,
          Math.round((info.damage ?? 120) * multiplier),
        ),
      );
      if (!target.hasHealth()) {
        this.alreadySentShell.add(target);
        this.destroyer.setTargetUnit(undefined);
      }
    }
  }

  private patrol() {
    if (this.destroyer.targetTile() === undefined) {
      this.destroyer.setTargetTile(this.randomTile());
      if (this.destroyer.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.destroyer.tile(),
      this.destroyer.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.destroyer.setTargetTile(undefined);
        this.destroyer.move(result.node);
        break;
      case PathStatus.NEXT:
        this.destroyer.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.destroyer.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const warshipComponent = mg.getWaterComponent(this.destroyer.tile());
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
    return this.destroyer?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
