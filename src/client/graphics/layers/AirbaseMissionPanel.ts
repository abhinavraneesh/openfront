import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { UnitMission, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, UnitView } from "../../../core/game/GameView";
import { CloseViewEvent, MouseUpEvent } from "../../InputHandler";
import {
  BuildUnitIntentEvent,
  SetUnitMissionIntentEvent,
  ShowAirbasePanelEvent,
  StartTargetingModeEvent,
} from "../../Transport";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

const AIRCRAFT_TYPES: UnitType[] = [
  UnitType.Fighter,
  UnitType.TacticalBomber,
  UnitType.StrategicBomber,
  UnitType.AttackHelicopter,
];

const CLICK_RADIUS = 4; // tiles
const STATIONED_RADIUS = 3; // tiles

interface MissionOption {
  label: string;
  mission: UnitMission;
  needsTarget?: boolean;
  targetingLabel?: string;
}

const MISSION_OPTIONS: Partial<Record<UnitType, MissionOption[]>> = {
  [UnitType.Fighter]: [
    { label: "Intercept (home base)", mission: UnitMission.INTERCEPT_HOME },
    { label: "Stand down", mission: UnitMission.STAND_DOWN },
  ],
  [UnitType.TacticalBomber]: [
    {
      label: "Strike target →",
      mission: UnitMission.STRIKE_TARGET,
      needsTarget: true,
      targetingLabel: "Select strike target",
    },
    { label: "Stand down", mission: UnitMission.STAND_DOWN },
  ],
  [UnitType.StrategicBomber]: [
    {
      label: "Cluster strike →",
      mission: UnitMission.CLUSTER_STRIKE,
      needsTarget: true,
      targetingLabel: "Select cluster strike target",
    },
    { label: "Stand down", mission: UnitMission.STAND_DOWN },
  ],
  [UnitType.AttackHelicopter]: [
    { label: "CAS (auto)", mission: UnitMission.AUTO },
    { label: "Stand down", mission: UnitMission.STAND_DOWN },
  ],
};

function statusText(mission: UnitMission | undefined): string {
  switch (mission) {
    case UnitMission.INTERCEPT_HOME:
      return "On alert";
    case UnitMission.INTERCEPT_PATROL:
      return "Patrolling";
    case UnitMission.STAND_DOWN:
      return "Stood down";
    case UnitMission.STRIKE_TARGET:
    case UnitMission.CLUSTER_STRIKE:
    case UnitMission.ATTACK_TILE:
    case UnitMission.CAS_NATION:
      return "On mission";
    default:
      return "Active";
  }
}

function unitTypeLabel(type: UnitType): string {
  switch (type) {
    case UnitType.Fighter:
      return "Fighter";
    case UnitType.TacticalBomber:
      return "Tac. Bomber";
    case UnitType.StrategicBomber:
      return "Strat. Bomber";
    case UnitType.AttackHelicopter:
      return "Attack Heli";
    case UnitType.Airbase:
      return "Airbase";
    case UnitType.Carrier:
      return "Carrier";
    default:
      return String(type);
  }
}

@customElement("airbase-mission-panel")
export class AirbaseMissionPanel extends LitElement implements Layer {
  public game: GameView;
  public eventBus: EventBus;
  public transformHandler: TransformHandler;

  @state() private _hostUnitId: number | null = null;
  @state() private _hidden = true;
  @state() private _selectedBuildType: UnitType = UnitType.Fighter;
  @state() private _tickCounter = 0;

  init() {
    this.eventBus.on(ShowAirbasePanelEvent, (e) => this.show(e.unitId));
    this.eventBus.on(CloseViewEvent, () => this.hide());
    this.eventBus.on(MouseUpEvent, (e) => this.onMouseUp(e));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this._hidden) this.hide();
    });
  }

  tick() {
    if (!this._hidden) {
      this._tickCounter++;
      this.requestUpdate();
    }
  }

  private onMouseUp(e: MouseUpEvent) {
    const cell = this.transformHandler.screenToWorldCoordinates(e.x, e.y);
    if (!this.game.isValidCoord(cell.x, cell.y)) return;
    const clickRef = this.game.ref(cell.x, cell.y);
    const me = this.game.myPlayer();
    if (!me) return;

    // Check own Airbase or Carrier near click
    let hit: UnitView | null = null;
    for (const unit of me.units(UnitType.Airbase, UnitType.Carrier)) {
      if (!unit.isActive()) continue;
      if (unit.isUnderConstruction()) continue;
      if (this.game.manhattanDist(unit.tile(), clickRef) <= CLICK_RADIUS) {
        hit = unit;
        break;
      }
    }

    if (hit) {
      this.show(hit.id());
      return;
    }

    // Click elsewhere hides the panel. Clicks inside the panel don't
    // reach MouseUpEvent because the panel is a fixed overlay
    // receiving pointer events directly.
    if (!this._hidden) this.hide();
  }

  private show(unitId: number) {
    this._hostUnitId = unitId;
    this._hidden = false;
    this.requestUpdate();
  }

  private hide() {
    this._hidden = true;
    this._hostUnitId = null;
    this.requestUpdate();
  }

  private host(): UnitView | undefined {
    if (this._hostUnitId === null) return undefined;
    return this.game.unit(this._hostUnitId);
  }

  private stationedAircraft(host: UnitView): UnitView[] {
    const me = this.game.myPlayer();
    if (!me) return [];
    const hostTile = host.tile();
    return me.units(...AIRCRAFT_TYPES).filter((u) => {
      if (!u.isActive()) return false;
      const home = u.patrolTile();
      if (home === undefined) return false;
      return this.game.manhattanDist(home, hostTile) <= STATIONED_RADIUS;
    });
  }

  private onBuild() {
    const host = this.host();
    if (!host) return;
    this.eventBus.emit(
      new BuildUnitIntentEvent(this._selectedBuildType, host.tile()),
    );
  }

  private onMissionChange(unit: UnitView, value: string) {
    if (!value) return;
    const options = MISSION_OPTIONS[unit.type()] ?? [];
    const opt = options.find((o) => o.mission === value);
    if (!opt) return;
    if (opt.needsTarget) {
      const unitId = unit.id();
      this.eventBus.emit(
        new StartTargetingModeEvent(
          opt.targetingLabel ?? "Select target",
          (tile: TileRef) => {
            this.eventBus.emit(
              new SetUnitMissionIntentEvent(unitId, opt.mission, tile),
            );
          },
        ),
      );
    } else {
      this.eventBus.emit(new SetUnitMissionIntentEvent(unit.id(), opt.mission));
    }
  }

  private recallAll() {
    const host = this.host();
    if (!host) return;
    for (const u of this.stationedAircraft(host)) {
      this.eventBus.emit(
        new SetUnitMissionIntentEvent(u.id(), UnitMission.STAND_DOWN),
      );
    }
  }

  static styles = css`
    :host {
      display: block;
    }
    .panel {
      position: fixed;
      top: 80px;
      right: 16px;
      width: 340px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      z-index: 950;
      background: #1e1e1e;
      border: 1px solid #2c2c2c;
      border-radius: 8px;
      color: #e5e7eb;
      font-family: monospace;
      font-size: 12px;
      padding: 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
    }
    .hidden {
      display: none !important;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .title {
      color: #facc15;
      font-weight: bold;
      font-size: 14px;
    }
    .hp-bar {
      height: 6px;
      background: #2c2c2c;
      border-radius: 3px;
      margin: 4px 0 10px 0;
      overflow: hidden;
    }
    .hp-fill {
      height: 100%;
      background: #22c55e;
    }
    .section-label {
      color: #9ca3af;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 10px 0 4px 0;
    }
    .divider {
      border: none;
      border-top: 1px solid #2c2c2c;
      margin: 10px 0;
    }
    .build-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    select,
    button {
      background: #2c2c2c;
      color: #e5e7eb;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 4px 6px;
      font-family: monospace;
      font-size: 12px;
      cursor: pointer;
    }
    select {
      flex: 1;
    }
    button:hover:not(:disabled) {
      background: #3a3a3a;
      border-color: #666;
    }
    button.primary {
      background: #facc15;
      color: #1e1e1e;
      border-color: #facc15;
      font-weight: bold;
    }
    button.primary:hover:not(:disabled) {
      background: #fde047;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .meta {
      color: #9ca3af;
      font-size: 11px;
    }
    .aircraft-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px 8px;
      padding: 6px;
      border: 1px solid #2c2c2c;
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .aircraft-head {
      display: flex;
      justify-content: space-between;
      grid-column: 1 / -1;
    }
    .aircraft-name {
      font-weight: bold;
    }
    .aircraft-status {
      color: #9ca3af;
    }
    .actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .empty {
      color: #9ca3af;
      padding: 8px 0;
      text-align: center;
    }
  `;

  render() {
    if (this._hidden) return html``;
    const host = this.host();
    if (!host || !host.isActive()) {
      return html``;
    }
    const info = this.game.config().unitInfo(host.type());
    const maxHp = info.maxHealth ?? 0;
    const hp = host.health();
    const hpPct =
      maxHp > 0 ? Math.max(0, Math.min(100, (hp / Number(maxHp)) * 100)) : 100;
    const stationed = this.stationedAircraft(host);

    const buildInfo = this.game.config().unitInfo(this._selectedBuildType);
    const buildSeconds = Math.round((buildInfo.constructionDuration ?? 0) / 10);

    return html`
      <div class="panel">
        <div class="header">
          <span class="title">${unitTypeLabel(host.type())}</span>
          <button @click=${() => this.hide()}>✕</button>
        </div>
        <div class="hp-bar">
          <div class="hp-fill" style="width: ${hpPct}%"></div>
        </div>
        <div class="meta">HP ${Math.round(hp)} / ${maxHp}</div>

        <hr class="divider" />
        <div class="section-label">Build queue</div>
        <div class="build-row">
          <select
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value as UnitType;
              this._selectedBuildType = v;
            }}
          >
            ${AIRCRAFT_TYPES.map(
              (t) => html`
                <option value=${t} ?selected=${t === this._selectedBuildType}>
                  ${unitTypeLabel(t)}
                </option>
              `,
            )}
          </select>
          <button class="primary" @click=${() => this.onBuild()}>Build</button>
        </div>
        <div class="meta" style="margin-top:4px">
          Build time: ${buildSeconds}s
        </div>

        <hr class="divider" />
        <div class="section-label">
          Stationed aircraft (${stationed.length})
        </div>
        ${stationed.length === 0
          ? html`<div class="empty">None</div>`
          : stationed.map((u) => this.renderAircraftRow(u))}

        <div class="actions">
          <button @click=${() => this.recallAll()}>Recall all</button>
          <button @click=${() => this.hide()}>Close</button>
        </div>
      </div>
    `;
  }

  private renderAircraftRow(u: UnitView) {
    const info = this.game.config().unitInfo(u.type());
    const maxHp = Number(info.maxHealth ?? 1);
    const hpPct = Math.max(0, Math.round((u.health() / maxHp) * 100));
    const options = MISSION_OPTIONS[u.type()] ?? [];
    const currentMission = u.mission();
    return html`
      <div class="aircraft-row">
        <div class="aircraft-head">
          <span class="aircraft-name">
            ${unitTypeLabel(u.type())} #${u.id()}
          </span>
          <span class="aircraft-status">
            HP ${hpPct}% · ${statusText(currentMission)}
          </span>
        </div>
        <select
          style="grid-column: 1 / -1"
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            this.onMissionChange(u, v);
            (e.target as HTMLSelectElement).value = "";
          }}
        >
          <option value="">Set mission…</option>
          ${options.map(
            (o) => html`
              <option value=${o.mission}>
                ${o.label}${currentMission === o.mission ? " ✓" : ""}
              </option>
            `,
          )}
        </select>
      </div>
    `;
  }
}
