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
import { NavalShellExecution } from "./NavalShellExecution";

export class BattleshipExecution implements Execution {
  private random: PseudoRandom;
  private battleship: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private lastAttack = 0;
  private alreadySentShell = new Set<Unit>();

  constructor(
    private input: (UnitParams<UnitType.Battleship> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    this.random = new PseudoRandom(mg.ticks());
    if (isUnit(this.input)) {
      this.battleship = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        UnitType.Battleship,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn Battleship for ${this.input.owner.name()}`,
        );
        return;
      }
      this.battleship = this.input.owner.buildUnit(
        UnitType.Battleship,
        spawn,
        this.input,
      );
    }
  }

  tick(ticks: number): void {
    if (!this.battleship?.isActive()) return;
    if (this.battleship.health() <= 0) {
      this.battleship.delete();
      return;
    }

    if (this.battleship.owner().unitCount(UnitType.Port) > 0) {
      this.battleship.modifyHealth(1);
    }

    this.battleship.setTargetUnit(this.findTarget());
    this.patrol();

    if (this.battleship.targetUnit() !== undefined) {
      this.shootTarget();
    }
  }

  private findTarget(): Unit | undefined {
    const config = this.mg.config();
    const info = config.unitInfo(UnitType.Battleship);
    const range = info.range ?? 150;
    const shoreRange = config.shoreBombardmentRange();
    const owner = this.battleship.owner();

    const navalTargets = this.mg.nearbyUnits(this.battleship.tile()!, range, [
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

    const shoreTargets = this.mg.nearbyUnits(
      this.battleship.tile()!,
      shoreRange,
      [
        UnitType.DefensePost,
        UnitType.CoastalBattery,
        UnitType.Port,
        UnitType.NavalYard,
        UnitType.City,
        UnitType.Factory,
        UnitType.SAMLauncher,
        UnitType.Airbase,
        UnitType.MissileSilo,
      ],
    );

    let best: Unit | undefined;
    let bestDist = Infinity;

    for (const { unit, distSquared } of [...navalTargets, ...shoreTargets]) {
      if (
        unit.owner() === owner ||
        unit === this.battleship ||
        !owner.canAttackPlayer(unit.owner(), true) ||
        this.alreadySentShell.has(unit)
      ) {
        continue;
      }
      const adjustedDist = navalTargets.some((n) => n.unit === unit)
        ? distSquared
        : distSquared * 4;
      if (adjustedDist < bestDist) {
        best = unit;
        bestDist = adjustedDist;
      }
    }
    return best;
  }

  private shootTarget() {
    const info = this.mg.config().unitInfo(UnitType.Battleship);
    const attackRate = info.attackRate ?? 25;
    if (this.mg.ticks() - this.lastAttack > attackRate) {
      this.lastAttack = this.mg.ticks();
      const target = this.battleship.targetUnit()!;
      const multiplier = this.mg
        .config()
        .combatMultiplier(UnitType.Battleship, target.type());
      this.mg.addExecution(
        new NavalShellExecution(
          this.battleship.tile(),
          this.battleship.owner(),
          this.battleship,
          target,
          Math.round((info.damage ?? 400) * multiplier),
        ),
      );
      if (!target.hasHealth()) {
        this.alreadySentShell.add(target);
        this.battleship.setTargetUnit(undefined);
      }
    }
  }

  private patrol() {
    if (this.battleship.targetTile() === undefined) {
      this.battleship.setTargetTile(this.randomTile());
      if (this.battleship.targetTile() === undefined) return;
    }

    const result = this.pathfinder.next(
      this.battleship.tile(),
      this.battleship.targetTile()!,
    );
    switch (result.status) {
      case PathStatus.COMPLETE:
        this.battleship.setTargetTile(undefined);
        this.battleship.move(result.node);
        break;
      case PathStatus.NEXT:
        this.battleship.move(result.node);
        break;
    }
  }

  private randomTile(allowShoreline = false): TileRef | undefined {
    const mg = this.mg;
    const patrolTile = this.battleship.patrolTile();
    if (patrolTile === undefined) return undefined;

    let patrolRange = mg.config().warshipPatrolRange();
    const warshipComponent = mg.getWaterComponent(this.battleship.tile());
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
    return this.battleship?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
