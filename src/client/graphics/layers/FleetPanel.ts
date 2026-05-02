import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { UnitMission, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, UnitView } from "../../../core/game/GameView";
import { CloseViewEvent } from "../../InputHandler";
import {
  SetUnitMissionIntentEvent,
  ShowFleetPanelEvent,
  StartTargetingModeEvent,
  TargetingMode,
} from "../../Transport";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";
import { GoToPositionEvent } from "./Leaderboard";
import { TargetingCancelledEvent } from "./TargetingCursor";

const SHIP_TYPES: UnitType[] = [
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Minelayer,
  UnitType.Warship,
];

const TARGET_SHIP_TYPES: UnitType[] = [
  ...SHIP_TYPES,
  UnitType.TransportShip,
  UnitType.TradeShip,
];

interface MissionOption {
  label: string;
  mission: UnitMission;
  needsTarget?: boolean;
  targetingLabel?: string;
  specialAttackShip?: boolean;
  specialEscort?: boolean;
  specialHuntSubmarine?: boolean;
  onlyFor?: UnitType[];
  targetingMode?: TargetingMode;
  oceanOnly?: boolean;
  rangeFromShip?: boolean;
}

const BASE_OPTIONS: MissionOption[] = [
  { label: "Auto patrol", mission: UnitMission.AUTO },
  {
    label: "Move to tile",
    mission: UnitMission.MOVE_TO_TILE,
    needsTarget: true,
    targetingLabel: "Select move destination",
    targetingMode: "move",
    oceanOnly: true,
  },
  {
    label: "Hold position",
    mission: UnitMission.HOLD_POSITION,
  },
  {
    label: "Patrol area",
    mission: UnitMission.PATROL_AREA,
    needsTarget: true,
    targetingLabel: "Select patrol center",
    targetingMode: "move",
    oceanOnly: true,
  },
  {
    label: "Escort",
    mission: UnitMission.ESCORT_UNIT,
    needsTarget: true,
    targetingLabel: "Select friendly ship to escort",
    specialEscort: true,
    targetingMode: "ship-escort",
  },
  { label: "Return to port", mission: UnitMission.RETURN_TO_PORT },
  {
    label: "Attack ship",
    mission: UnitMission.ATTACK_SHIP,
    needsTarget: true,
    targetingLabel: "Select enemy ship",
    specialAttackShip: true,
    targetingMode: "ship-attack",
  },
  {
    label: "Hunt submarine",
    mission: UnitMission.HUNT_SUBMARINE,
    needsTarget: true,
    targetingLabel: "Select enemy submarine to hunt",
    specialHuntSubmarine: true,
    onlyFor: [UnitType.Destroyer],
  },
  {
    label: "Bombard coast",
    mission: UnitMission.BOMBARD_COAST,
    needsTarget: true,
    targetingLabel: "Select coastal target",
    onlyFor: [UnitType.Cruiser, UnitType.Battleship],
    targetingMode: "bombard",
    rangeFromShip: true,
  },
  {
    label: "Lay mine →",
    mission: UnitMission.LAY_MINE,
    needsTarget: true,
    targetingLabel: "Select tile to mine",
    onlyFor: [UnitType.Minelayer],
    targetingMode: "mine",
    oceanOnly: true,
  },
  {
    label: "Sweep mines →",
    mission: UnitMission.SWEEP_MINES,
    needsTarget: true,
    targetingLabel: "Select area to sweep — costs 200g (10 ticks)",
    onlyFor: [UnitType.Destroyer],
    targetingMode: "move",
    oceanOnly: true,
  },
];

function missionApplies(opt: MissionOption, type: UnitType): boolean {
  return opt.onlyFor === undefined || opt.onlyFor.includes(type);
}

function statusText(mission: UnitMission | undefined): string {
  switch (mission) {
    case undefined:
    case UnitMission.AUTO:
      return "Patrolling home";
    case UnitMission.MOVE_TO_TILE:
      return "Moving to position";
    case UnitMission.HOLD_POSITION:
      return "Holding position";
    case UnitMission.PATROL_AREA:
      return "Patrolling area";
    case UnitMission.BOMBARD_COAST:
      return "Bombarding coast";
    case UnitMission.ESCORT_UNIT:
      return "Escorting";
    case UnitMission.ATTACK_SHIP:
      return "Hunting target";
    case UnitMission.HUNT_SUBMARINE:
      return "Hunting submarines";
    case UnitMission.SWEEP_MINES:
      return "Sweeping mines";
    case UnitMission.LAY_MINE:
      return "Laying mine";
    case UnitMission.RETURN_TO_PORT:
      return "Returning to port";
    default:
      return "Active";
  }
}

function shipTypeLabel(type: UnitType): string {
  switch (type) {
    case UnitType.Destroyer:
      return "Destroyer";
    case UnitType.Cruiser:
      return "Cruiser";
    case UnitType.Battleship:
      return "Battleship";
    case UnitType.Submarine:
      return "Submarine";
    case UnitType.Carrier:
      return "Carrier";
    case UnitType.Minelayer:
      return "Minelayer";
    case UnitType.Warship:
      return "Warship";
    default:
      return String(type);
  }
}

function groupHeader(type: UnitType): string {
  return `${shipTypeLabel(type).toUpperCase()}S`;
}

@customElement("fleet-panel")
export class FleetPanel extends LitElement implements Layer {
  public game: GameView;
  public eventBus: EventBus;
  public transformHandler: TransformHandler;

  @state() private _hidden = true;
  @state() private _tickCounter = 0;

  init() {
    this.eventBus.on(ShowFleetPanelEvent, () => this.toggle());
    this.eventBus.on(CloseViewEvent, () => this.hide());
    this.eventBus.on(TargetingCancelledEvent, () => {
      window.setTimeout(() => this.show(), 0);
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this._hidden) this.hide();
    });
  }

  tick() {
    this._tickCounter++;
    if (!this._hidden) this.requestUpdate();
  }

  renderLayer(context: CanvasRenderingContext2D) {
    if (!this.game) return;

    // Pulsing red rings on blockaded ports.
    const ports = this.blockadedPorts();
    if (ports.length > 0) {
      const scale = this.transformHandler?.scale ?? 1;
      const pulse = (Math.sin(performance.now() / 220) + 1) / 2;
      context.save();
      context.lineWidth = Math.max(1 / scale, 0.45);
      context.strokeStyle = `rgba(239, 68, 68, ${0.5 + pulse * 0.35})`;
      context.fillStyle = `rgba(239, 68, 68, ${0.05 + pulse * 0.06})`;
      for (const port of ports) {
        const x = this.game.x(port.tile()) + 0.5;
        const y = this.game.y(port.tile()) + 0.5;
        context.beginPath();
        context.arc(x, y, 4 + pulse * 1.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      context.restore();
    }

    // Dashed lines from ships to their mission destinations.
    this.renderShipMissionLines(context);
  }

  /**
   * Draw a dashed line + pulsing destination marker from each ship to its
   * active mission target tile (MOVE_TO_TILE, PATROL_AREA, BOMBARD_COAST).
   * Runs in world-space coordinates (shouldTransform = true).
   */
  private renderShipMissionLines(context: CanvasRenderingContext2D) {
    const me = this.game.myPlayer();
    if (!me) return;

    const scale = this.transformHandler?.scale ?? 1;
    const pulse = (Math.sin(performance.now() / 400) + 1) / 2;
    const lw = Math.max(1.2 / scale, 0.3);
    const dashLen = 5 / scale;
    const gapLen = 3 / scale;

    // Mission → stroke color
    const missionColor: Partial<Record<UnitMission, string>> = {
      [UnitMission.MOVE_TO_TILE]: "#22d3ee", // cyan
      [UnitMission.PATROL_AREA]: "#facc15", // yellow
      [UnitMission.BOMBARD_COAST]: "#fb923c", // orange
    };

    context.save();
    context.lineWidth = lw;

    for (const type of SHIP_TYPES) {
      for (const ship of me.units(type)) {
        if (!ship.isActive() || ship.isUnderConstruction()) continue;
        const mission = ship.mission();
        const destTile = ship.missionTargetTile();
        if (destTile === undefined) continue;
        const color = missionColor[mission as UnitMission];
        if (!color) continue;

        const sx = this.game.x(ship.tile()) + 0.5;
        const sy = this.game.y(ship.tile()) + 0.5;
        const dx = this.game.x(destTile) + 0.5;
        const dy = this.game.y(destTile) + 0.5;

        // Skip when already at destination.
        const dist2 = (sx - dx) ** 2 + (sy - dy) ** 2;
        if (dist2 < 0.25) continue;

        context.strokeStyle = color;

        // Dashed line from ship to destination.
        context.globalAlpha = 0.55;
        context.setLineDash([dashLen, gapLen]);
        context.beginPath();
        context.moveTo(sx, sy);
        context.lineTo(dx, dy);
        context.stroke();

        // Pulsing circle at destination.
        const r = Math.max(2.5 / scale, 0.6) + (pulse * 0.8) / scale;
        context.globalAlpha = 0.7 + pulse * 0.3;
        context.setLineDash([]);
        context.beginPath();
        context.arc(dx, dy, r, 0, Math.PI * 2);
        context.stroke();
      }
    }

    context.setLineDash([]);
    context.globalAlpha = 1;
    context.restore();
  }

  shouldTransform(): boolean {
    return true;
  }

  private toggle() {
    if (this._hidden) this.show();
    else this.hide();
  }

  private show() {
    this._hidden = false;
    this.requestUpdate();
  }

  private hide() {
    this._hidden = true;
    this.requestUpdate();
  }

  private getShips(): UnitView[] {
    const me = this.game.myPlayer();
    if (!me) return [];
    const ships: UnitView[] = [];
    for (const type of SHIP_TYPES) {
      for (const u of me.units(type)) {
        if (u.isActive() && !u.isUnderConstruction()) ships.push(u);
      }
    }
    return ships;
  }

  private groupShips(ships: UnitView[]): Map<UnitType, UnitView[]> {
    const groups = new Map<UnitType, UnitView[]>();
    for (const type of SHIP_TYPES) {
      const ofType = ships.filter((s) => s.type() === type);
      if (ofType.length > 0) groups.set(type, ofType);
    }
    return groups;
  }

  private onFocus(ship: UnitView) {
    const tile = ship.tile();
    this.eventBus.emit(
      new GoToPositionEvent(this.game.x(tile), this.game.y(tile)),
    );
  }

  private onMissionChange(ship: UnitView, value: string) {
    if (!value) return;
    const opt = BASE_OPTIONS.find((o) => o.mission === value);
    if (!opt || !missionApplies(opt, ship.type())) return;

    if (!opt.needsTarget) {
      this.eventBus.emit(new SetUnitMissionIntentEvent(ship.id(), opt.mission));
      return;
    }

    this.startTargeting(ship, opt);
  }

  private startTargeting(ship: UnitView, opt: MissionOption) {
    const shipId = ship.id();
    const originTile = ship.tile();
    let range: number | undefined;
    if (opt.rangeFromShip) {
      range = this.game.config().unitInfo(ship.type()).range ?? undefined;
    } else if (opt.mission === UnitMission.BOMBARD_COAST) {
      // Spec: BB bombard range 10 tiles, CA bombard range 6 tiles.
      if (ship.type() === UnitType.Battleship) range = 10;
      else if (ship.type() === UnitType.Cruiser) range = 6;
    }

    this.hide();
    this.eventBus.emit(
      new StartTargetingModeEvent(
        opt.targetingLabel ?? "Select target",
        (tile: TileRef) => {
          this.show();
          if (opt.specialAttackShip || opt.specialHuntSubmarine) {
            const target = this.nearestTargetShip(
              tile,
              opt.specialHuntSubmarine,
            );
            if (!target) return;
            this.eventBus.emit(
              new SetUnitMissionIntentEvent(
                shipId,
                opt.mission,
                undefined,
                target.id(),
              ),
            );
            return;
          }
          if (opt.specialEscort) {
            const target = this.nearestEscortShip(tile, shipId);
            if (!target) return;
            this.eventBus.emit(
              new SetUnitMissionIntentEvent(
                shipId,
                opt.mission,
                undefined,
                target.id(),
              ),
            );
            return;
          }
          this.eventBus.emit(
            new SetUnitMissionIntentEvent(shipId, opt.mission, tile),
          );
        },
        range,
        originTile,
        opt.targetingMode ?? "tile",
        (tile: TileRef) => this.isValidTarget(tile, ship, opt, range),
      ),
    );
  }

  private isValidTarget(
    tile: TileRef,
    ship: UnitView,
    opt: MissionOption,
    range?: number,
  ): boolean {
    if (opt.oceanOnly && !this.game.isOcean(tile)) return false;
    if (
      range !== undefined &&
      this.game.euclideanDistSquared(ship.tile(), tile) > range * range
    ) {
      return false;
    }
    if (opt.specialAttackShip || opt.specialHuntSubmarine) {
      return (
        this.nearestTargetShip(tile, opt.specialHuntSubmarine) !== undefined
      );
    }
    if (opt.specialEscort) {
      return this.nearestEscortShip(tile, ship.id()) !== undefined;
    }
    return true;
  }

  private nearestTargetShip(
    tile: TileRef,
    submarineOnly = false,
  ): UnitView | undefined {
    const me = this.game.myPlayer();
    if (!me) return undefined;
    const candidates = this.game.nearbyUnits(tile, 20, TARGET_SHIP_TYPES);
    let best: UnitView | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of candidates) {
      if (!unit.isActive()) continue;
      if (
        unit.owner().smallID() === me.smallID() ||
        unit.owner().isFriendly(me)
      ) {
        continue;
      }
      if (submarineOnly && unit.type() !== UnitType.Submarine) continue;
      if (distSquared < bestDist) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  private nearestEscortShip(
    tile: TileRef,
    selfId: number,
  ): UnitView | undefined {
    const me = this.game.myPlayer();
    if (!me) return undefined;
    const candidates = this.game.nearbyUnits(tile, 20, SHIP_TYPES);
    let best: UnitView | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of candidates) {
      if (!unit.isActive()) continue;
      if (unit.id() === selfId) continue;
      if (unit.owner().smallID() !== me.smallID()) continue;
      if (distSquared < bestDist) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  private hpColor(pct: number): string {
    if (pct > 60) return "#22c55e";
    if (pct > 30) return "#eab308";
    return "#ef4444";
  }

  private homePort(ship: UnitView): UnitView | undefined {
    const home = ship.patrolTile();
    if (home === undefined) return undefined;
    const me = this.game.myPlayer();
    if (!me) return undefined;
    return me
      .units(UnitType.Port)
      .find((port) => port.isActive() && port.tile() === home);
  }

  private isBlockadedPort(port: UnitView): boolean {
    return port.blockaded();
  }

  private blockadedPorts(): UnitView[] {
    const me = this.game?.myPlayer();
    if (!me) return [];
    return me
      .units(UnitType.Port)
      .filter((port) => port.isActive() && port.blockaded());
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
      margin-bottom: 8px;
    }
    .title {
      color: #facc15;
      font-weight: bold;
      font-size: 14px;
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
      margin: 6px 0;
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
    button:hover:not(:disabled) {
      background: #3a3a3a;
      border-color: #666;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ship-row {
      border: 1px solid #2c2c2c;
      border-radius: 4px;
      padding: 6px;
      margin-bottom: 6px;
    }
    .ship-head {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 3px;
    }
    .ship-name {
      font-weight: bold;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hp-pct {
      font-size: 11px;
      color: #9ca3af;
      white-space: nowrap;
    }
    .badge {
      font-size: 10px;
      font-weight: bold;
      padding: 1px 4px;
      border-radius: 3px;
      white-space: nowrap;
    }
    .badge-blockade {
      background: rgba(220, 38, 38, 0.2);
      border: 1px solid rgba(220, 38, 38, 0.5);
      color: #fca5a5;
    }
    .badge-noport {
      background: rgba(113, 113, 122, 0.2);
      border: 1px solid rgba(113, 113, 122, 0.4);
      color: #a1a1aa;
    }
    .hp-bar {
      height: 5px;
      background: #2c2c2c;
      border-radius: 3px;
      margin: 2px 0 6px 0;
      overflow: hidden;
    }
    .hp-fill {
      height: 100%;
      border-radius: 3px;
    }
    .ship-footer {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .ship-status {
      flex: 1;
      color: #9ca3af;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty {
      color: #9ca3af;
      padding: 8px 0;
      text-align: center;
    }
  `;

  render() {
    if (this._hidden) return html``;
    const me = this.game.myPlayer();
    const ships = this.getShips();
    const groups = this.groupShips(ships);

    return html`
      <div
        class="panel"
        @mousedown=${(e: MouseEvent) => e.stopPropagation()}
        @click=${(e: MouseEvent) => e.stopPropagation()}
        @wheel=${(e: WheelEvent) => e.stopPropagation()}
      >
        <div class="header">
          <span class="title"
            >⚓ Fleet${me ? ` — ${me.displayName()}` : ""}</span
          >
          <button @click=${() => this.hide()}>✕</button>
        </div>
        ${groups.size === 0
          ? html`<div class="empty">No ships in fleet</div>`
          : Array.from(groups.entries()).map(
              ([type, list]) => html`
                <div class="section-label">
                  ${groupHeader(type)} (${list.length})
                </div>
                <hr class="divider" />
                ${list.map((ship, i) => this.renderShipRow(ship, i + 1))}
              `,
            )}
      </div>
    `;
  }

  private renderShipRow(ship: UnitView, displayId: number) {
    const info = this.game.config().unitInfo(ship.type());
    const maxHp = Number(info.maxHealth ?? 1);
    const pct = Math.max(
      0,
      Math.min(100, Math.round((ship.health() / maxHp) * 100)),
    );
    const currentMission = ship.mission();
    const homePort = this.homePort(ship);
    const homeless = homePort === undefined;
    const blockaded = homePort !== undefined && this.isBlockadedPort(homePort);

    return html`
      <div class="ship-row">
        <div class="ship-head">
          <span class="ship-name"
            >${shipTypeLabel(ship.type())} #${displayId}</span
          >
          ${blockaded
            ? html`<span class="badge badge-blockade">BLOCKADE</span>`
            : ""}
          ${homeless
            ? html`<span class="badge badge-noport">NO PORT</span>`
            : ""}
          <span class="hp-pct">${pct}%</span>
        </div>
        <div class="hp-bar">
          <div
            class="hp-fill"
            style="width:${pct}%;background:${this.hpColor(pct)}"
          ></div>
        </div>
        <div class="ship-footer">
          <span class="ship-status">${statusText(currentMission)}</span>
          <select
            @change=${(e: Event) => {
              const select = e.target as HTMLSelectElement;
              this.onMissionChange(ship, select.value);
              select.value = "";
            }}
          >
            <option value="">Mission</option>
            ${BASE_OPTIONS.map((opt) => {
              const applies = missionApplies(opt, ship.type());
              return html`<option value=${opt.mission} ?disabled=${!applies}>
                ${opt.label}${currentMission === opt.mission
                  ? " ✓"
                  : ""}${applies ? "" : " (N/A)"}
              </option>`;
            })}
          </select>
          <button @click=${() => this.onFocus(ship)} title="Go to ship">
            ⊙
          </button>
        </div>
      </div>
    `;
  }
}
