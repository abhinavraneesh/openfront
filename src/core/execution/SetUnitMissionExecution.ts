import { Execution, Game, Player, UnitMission } from "../game/Game";
import { TileRef } from "../game/GameMap";

export class SetUnitMissionExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private unitId: number,
    private mission: UnitMission,
    private targetTile?: TileRef,
    private targetUnitId?: number,
  ) {}

  init(mg: Game, _ticks: number): void {
    const unit = mg
      .units()
      .find((u) => u.id() === this.unitId && u.owner() === this.player);

    if (!unit || !unit.isActive()) {
      this.active = false;
      return;
    }

    unit.setMission(this.mission);
    unit.setMissionTargetTile(this.targetTile);
    unit.setMissionTargetUnitId(this.targetUnitId);
    this.active = false;
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
