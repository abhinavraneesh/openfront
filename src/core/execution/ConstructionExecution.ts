import { Execution, Game, Player, Tick, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { AirbaseExecution } from "./AirbaseExecution";
import { AttackHelicopterExecution } from "./AttackHelicopterExecution";
import { BattleshipExecution } from "./BattleshipExecution";
import { BomberExecution } from "./BomberExecution";
import { CarrierExecution } from "./CarrierExecution";
import { CityExecution } from "./CityExecution";
import { CoastalBatteryExecution } from "./CoastalBatteryExecution";
import { CruiserExecution } from "./CruiserExecution";
import { DefensePostExecution } from "./DefensePostExecution";
import { DestroyerExecution } from "./DestroyerExecution";
import { FactoryExecution } from "./FactoryExecution";
import { FighterExecution } from "./FighterExecution";
import { MinelayerExecution } from "./MinelayerExecution";
import { MirvExecution } from "./MIRVExecution";
import { MissileSiloExecution } from "./MissileSiloExecution";
import { NavalYardExecution } from "./NavalYardExecution";
import { NukeExecution } from "./NukeExecution";
import { PortExecution } from "./PortExecution";
import { SAMLauncherExecution } from "./SAMLauncherExecution";
import { SubmarineExecution } from "./SubmarineExecution";
import { WarshipExecution } from "./WarshipExecution";

export class ConstructionExecution implements Execution {
  private structure: Unit | null = null;
  private active: boolean = true;
  private mg: Game;

  private ticksUntilComplete: Tick;

  constructor(
    private player: Player,
    private constructionType: UnitType,
    private tile: TileRef,
    private rocketDirectionUp?: boolean,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (this.mg.config().isUnitDisabled(this.constructionType)) {
      console.warn(
        `cannot build construction ${this.constructionType} because it is disabled`,
      );
      this.active = false;
      return;
    }

    if (!this.mg.isValidRef(this.tile)) {
      console.warn(`cannot build construction invalid tile ${this.tile}`);
      this.active = false;
      return;
    }
  }

  tick(ticks: number): void {
    if (this.structure === null) {
      const info = this.mg.unitInfo(this.constructionType);
      // For non-structure units (nukes/warship), charge once and delegate to specialized executions.
      const isStructure = this.isStructure(this.constructionType);
      if (!isStructure) {
        // Defer validation and gold deduction to the specific execution
        this.completeConstruction();
        this.active = false;
        return;
      }

      // Structures: build real unit and mark under construction
      const spawnTile = this.player.canBuild(this.constructionType, this.tile);
      if (spawnTile === false) {
        console.warn(`cannot build ${this.constructionType}`);
        this.active = false;
        return;
      }
      this.structure = this.player.buildUnit(
        this.constructionType,
        spawnTile,
        {},
      );
      const duration = info.constructionDuration ?? 0;
      if (duration > 0) {
        this.structure.setUnderConstruction(true);
        this.ticksUntilComplete = duration;
        return;
      }
      // No construction time
      this.completeConstruction();
      this.active = false;
      return;
    }

    if (!this.structure.isActive()) {
      this.active = false;
      return;
    }

    if (this.player !== this.structure.owner()) {
      this.player = this.structure.owner();
    }

    if (this.ticksUntilComplete === 0) {
      this.player = this.structure.owner();
      this.completeConstruction();
      this.active = false;
      return;
    }
    this.ticksUntilComplete--;
  }

  private completeConstruction() {
    if (this.structure) {
      this.structure.setUnderConstruction(false);
    }
    const player = this.player;
    switch (this.constructionType) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
        this.mg.addExecution(
          new NukeExecution(
            this.constructionType,
            player,
            this.tile,
            null,
            -1,
            0,
            this.rocketDirectionUp,
          ),
        );
        break;
      case UnitType.MIRV:
        this.mg.addExecution(new MirvExecution(player, this.tile));
        break;
      case UnitType.Warship:
        this.mg.addExecution(
          new WarshipExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Destroyer:
        this.mg.addExecution(
          new DestroyerExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Cruiser:
        this.mg.addExecution(
          new CruiserExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Battleship:
        this.mg.addExecution(
          new BattleshipExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Submarine:
        this.mg.addExecution(
          new SubmarineExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Minelayer:
        this.mg.addExecution(
          new MinelayerExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Port:
        this.mg.addExecution(new PortExecution(this.structure!));
        break;
      case UnitType.MissileSilo:
        this.mg.addExecution(new MissileSiloExecution(this.structure!));
        break;
      case UnitType.DefensePost:
        this.mg.addExecution(new DefensePostExecution(this.structure!));
        break;
      case UnitType.SAMLauncher:
        this.mg.addExecution(
          new SAMLauncherExecution(player, null, this.structure!),
        );
        break;
      case UnitType.City:
        this.mg.addExecution(new CityExecution(this.structure!));
        break;
      case UnitType.Factory:
        this.mg.addExecution(new FactoryExecution(this.structure!));
        break;
      case UnitType.Airbase:
        this.mg.addExecution(new AirbaseExecution(this.structure!));
        break;
      case UnitType.Fighter:
        this.mg.addExecution(
          new FighterExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Bomber:
        this.mg.addExecution(
          new BomberExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.AttackHelicopter:
        this.mg.addExecution(
          new AttackHelicopterExecution({
            owner: player,
            patrolTile: this.tile,
          }),
        );
        break;
      case UnitType.NavalYard:
        this.mg.addExecution(new NavalYardExecution(this.structure!));
        break;
      case UnitType.CoastalBattery:
        this.mg.addExecution(new CoastalBatteryExecution(this.structure!));
        break;
      case UnitType.Carrier:
        this.mg.addExecution(
          new CarrierExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      default:
        console.warn(
          `unit type ${this.constructionType} cannot be constructed`,
        );
        break;
    }
  }

  private isStructure(type: UnitType): boolean {
    switch (type) {
      case UnitType.Port:
      case UnitType.MissileSilo:
      case UnitType.DefensePost:
      case UnitType.SAMLauncher:
      case UnitType.City:
      case UnitType.Factory:
      case UnitType.Airbase:
      case UnitType.NavalYard:
      case UnitType.CoastalBattery:
        return true;
      default:
        return false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
