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
  StopTargetingModeEvent,
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
  needsNation?: boolean;
}

const MISSION_OPTIONS: Partial<Record<UnitType, MissionOption[]>> = {
  [UnitType.Fighter]: [
    { label: "Intercept (home base)", mission: UnitMission.INTERCEPT_HOME },
    {
      label: "Intercept (patrol tile) →",
      mission: UnitMission.INTERCEPT_PATROL,
      needsTarget: true,
      targetingLabel: "Select patrol center",
    },
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
    {
      label: "CAS — select nation →",
      mission: UnitMission.CAS_NATION,
      needsNation: true,
    },
    {
      label: "Attack tile →",
      mission: UnitMission.ATTACK_TILE,
      needsTarget: true,
      targetingLabel: "Select attack tile",
    },
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
      return "Strike mission";
    case UnitMission.CLUSTER_STRIKE:
      return "Cluster mission";
    case UnitMission.ATTACK_TILE:
      return "CAS attack";
    case UnitMission.CAS_NATION:
      return "CAS active";
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
  @state() private _nationPickUnitId: number | null = null;
  @state() private _nationPickMission: UnitMission | null = null;
  // When a tile-picking flow is in progress we suppress the next outside-click
  // hide so the panel stays open after the targeting click commits.
  private _targetingActive = false;

  init() {
    this.eventBus.on(ShowAirbasePanelEvent, (e) => this.show(e.unitId));
    this.eventBus.on(CloseViewEvent, () => this.hide());
    this.eventBus.on(MouseUpEvent, (e) => this.onMouseUp(e));
    this.eventBus.on(StartTargetingModeEvent, () => {
      this._targetingActive = true;
    });
    this.eventBus.on(StopTargetingModeEvent, () => {
      // Defer clearing one tick so the MouseUpEvent that ends targeting
      // also gets ignored by this panel (StopTargetingMode is emitted
      // before MouseUpEvent reaches our listener in some orderings).
      setTimeout(() => {
        this._targetingActive = false;
      }, 0);
    });
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
    // Don't process clicks while a tile-picking flow is committing — the
    // click belongs to that flow, not to airbase selection / panel hide.
    if (this._targetingActive) return;
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

    // Click elsewhere does NOT hide the panel — the user needs to be able
    // to pan/zoom the map while the mission panel is open. Close via the
    // ✕ button or Escape key instead.
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
    if (opt.needsNation) {
      this._nationPickUnitId = unit.id();
      this._nationPickMission = opt.mission;
      return;
    }
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

  private onNationSelect(smallID: number) {
    if (this._nationPickUnitId === null || this._nationPickMission === null)
      return;
    this.eventBus.emit(
      new SetUnitMissionIntentEvent(
        this._nationPickUnitId,
        this._nationPickMission,
        undefined,
        smallID,
      ),
    );
    this._nationPickUnitId = null;
    this._nationPickMission = null;
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

  private scrambleAllFighters() {
    const host = this.host();
    if (!host) return;
    for (const u of this.stationedAircraft(host)) {
      if (u.type() !== UnitType.Fighter) continue;
      this.eventBus.emit(
        new SetUnitMissionIntentEvent(u.id(), UnitMission.INTERCEPT_HOME),
      );
    }
  }

  private enemyNations(): { smallID: number; name: string }[] {
    const me = this.game.myPlayer();
    if (!me) return [];
    const myID = me.smallID();
    const nations: { smallID: number; name: string }[] = [];
    for (const p of this.game.players()) {
      if (!p.isAlive()) continue;
      if (p.smallID() === myID) continue;
      nations.push({ smallID: p.smallID(), name: p.displayName() });
    }
    nations.sort((a, b) => a.name.localeCompare(b.name));
    return nations;
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
          <button @click=${() => this.scrambleAllFighters()}>
            Scramble all fighters
          </button>
          <button @click=${() => this.hide()}>Close</button>
        </div>
        ${this._nationPickUnitId !== null ? this.renderNationPicker() : ""}
      </div>
    `;
  }

  private renderNationPicker() {
    const nations = this.enemyNations();
    return html`
      <hr class="divider" />
      <div class="section-label">Select nation to hunt</div>
      ${nations.length === 0
        ? html`<div class="empty">No visible enemy nations</div>`
        : html`
            <select
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v) this.onNationSelect(Number(v));
              }}
            >
              <option value="">Choose nation…</option>
              ${nations.map(
                (n) => html`
                  <option value=${String(n.smallID)}>${n.name}</option>
                `,
              )}
            </select>
          `}
      <div class="actions">
        <button
          @click=${() => {
            this._nationPickUnitId = null;
            this._nationPickMission = null;
          }}
        >
          Cancel
        </button>
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
          <option value="">
            ${currentMission !== undefined
              ? `Current: ${statusText(currentMission)}`
              : "Set mission…"}
          </option>
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
