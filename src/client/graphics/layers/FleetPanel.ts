import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { UnitMission, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, UnitView } from "../../../core/game/GameView";
import { CloseViewEvent, MouseDownEvent } from "../../InputHandler";
import {
  SetUnitMissionIntentEvent,
  ShowFleetPanelEvent,
  StartTargetingModeEvent,
  StopTargetingModeEvent,
} from "../../Transport";
import { Layer } from "./Layer";
import { GoToPositionEvent } from "./Leaderboard";

const SHIP_TYPES: UnitType[] = [
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Minelayer,
  UnitType.Warship,
];

interface MissionOption {
  label: string;
  mission: UnitMission;
  needsTarget?: boolean;
  targetingLabel?: string;
  specialAttackShip?: boolean;
  specialEscort?: boolean;
  onlyFor?: UnitType[];
}

const BASE_OPTIONS: MissionOption[] = [
  { label: "Auto patrol", mission: UnitMission.AUTO },
  {
    label: "Move to tile →",
    mission: UnitMission.MOVE_TO_TILE,
    needsTarget: true,
    targetingLabel: "Select move destination",
  },
  {
    label: "Patrol area →",
    mission: UnitMission.PATROL_AREA,
    needsTarget: true,
    targetingLabel: "Select patrol center",
  },
  {
    label: "Escort unit →",
    mission: UnitMission.ESCORT_UNIT,
    needsTarget: true,
    targetingLabel: "Select friendly ship to escort",
    specialEscort: true,
  },
  { label: "Return to port", mission: UnitMission.RETURN_TO_PORT },
  {
    label: "Attack ship →",
    mission: UnitMission.ATTACK_SHIP,
    needsTarget: true,
    targetingLabel: "Select enemy ship (click near target)",
    specialAttackShip: true,
  },
  {
    label: "Bombard coast →",
    mission: UnitMission.BOMBARD_COAST,
    needsTarget: true,
    targetingLabel: "Select coastal target",
    onlyFor: [UnitType.Cruiser, UnitType.Battleship],
  },
];

function missionApplies(opt: MissionOption, type: UnitType): boolean {
  if (!opt.onlyFor) return true;
  return opt.onlyFor.includes(type);
}

function statusText(mission: UnitMission | undefined): string {
  switch (mission) {
    case undefined:
    case UnitMission.AUTO:
      return "Patrolling (home)";
    case UnitMission.MOVE_TO_TILE:
      return "Moving to position";
    case UnitMission.PATROL_AREA:
      return "Patrolling area";
    case UnitMission.BOMBARD_COAST:
      return "Bombarding";
    case UnitMission.ESCORT_UNIT:
      return "Escorting";
    case UnitMission.ATTACK_SHIP:
      return "Hunting target";
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
  switch (type) {
    case UnitType.Destroyer:
      return "DESTROYERS";
    case UnitType.Cruiser:
      return "CRUISERS";
    case UnitType.Battleship:
      return "BATTLESHIPS";
    case UnitType.Submarine:
      return "SUBMARINES";
    case UnitType.Carrier:
      return "CARRIERS";
    case UnitType.Minelayer:
      return "MINELAYERS";
    case UnitType.Warship:
      return "WARSHIPS";
    default:
      return String(type).toUpperCase();
  }
}

@customElement("fleet-panel")
export class FleetPanel extends LitElement implements Layer {
  public game: GameView;
  public eventBus: EventBus;

  @state() private _hidden = true;
  @state() private _tickCounter = 0;
  private _targetingActive = false;

  init() {
    this.eventBus.on(ShowFleetPanelEvent, () => this.toggle());
    this.eventBus.on(CloseViewEvent, () => this.hide());
    this.eventBus.on(MouseDownEvent, () => {
      // Map clicks close the panel; clicks inside the panel don't bubble
      // up to MouseDownEvent because it absorbs pointer events. Suppress
      // close while a tile-picking flow is committing.
      if (this._targetingActive) return;
      if (!this._hidden) this.hide();
    });
    this.eventBus.on(StartTargetingModeEvent, () => {
      this._targetingActive = true;
    });
    this.eventBus.on(StopTargetingModeEvent, () => {
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
        if (u.isActive() && !u.isUnderConstruction()) {
          ships.push(u);
        }
      }
    }
    return ships;
  }

  private groupShips(ships: UnitView[]): Map<UnitType, UnitView[]> {
    const groups = new Map<UnitType, UnitView[]>();
    for (const type of SHIP_TYPES) {
      const ofType = ships.filter((s) => s.type() === type);
      if (ofType.length > 0) {
        groups.set(type, ofType);
      }
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
    if (!opt) return;

    if (!opt.needsTarget) {
      this.eventBus.emit(new SetUnitMissionIntentEvent(ship.id(), opt.mission));
      return;
    }

    const shipId = ship.id();
    const eventBus = this.eventBus;
    const game = this.game;
    const me = game.myPlayer();
    const myId = me?.id();

    this.eventBus.emit(
      new StartTargetingModeEvent(
        opt.targetingLabel ?? "Select target",
        (tile: TileRef) => {
          if (opt.specialAttackShip) {
            // Find nearest enemy ship to the clicked tile
            const candidates = game.nearbyUnits(tile, 20, SHIP_TYPES);
            let best: UnitView | undefined;
            let bestDist = Infinity;
            for (const { unit, distSquared } of candidates) {
              if (myId !== undefined && unit.owner().id() === myId) continue;
              if (!unit.isActive()) continue;
              if (distSquared < bestDist) {
                best = unit;
                bestDist = distSquared;
              }
            }
            if (best) {
              eventBus.emit(
                new SetUnitMissionIntentEvent(
                  shipId,
                  opt.mission,
                  undefined,
                  best.id(),
                ),
              );
            }
          } else if (opt.specialEscort) {
            // Find nearest friendly ship to the clicked tile (not self)
            const candidates = game.nearbyUnits(tile, 20, SHIP_TYPES);
            let best: UnitView | undefined;
            let bestDist = Infinity;
            for (const { unit, distSquared } of candidates) {
              if (myId === undefined) continue;
              if (unit.owner().id() !== myId) continue;
              if (unit.id() === shipId) continue;
              if (!unit.isActive()) continue;
              if (distSquared < bestDist) {
                best = unit;
                bestDist = distSquared;
              }
            }
            if (best) {
              eventBus.emit(
                new SetUnitMissionIntentEvent(
                  shipId,
                  opt.mission,
                  undefined,
                  best.id(),
                ),
              );
            }
          } else {
            eventBus.emit(
              new SetUnitMissionIntentEvent(shipId, opt.mission, tile),
            );
          }
        },
      ),
    );
  }

  private hpColor(pct: number): string {
    if (pct > 60) return "#22c55e";
    if (pct > 30) return "#eab308";
    return "#ef4444";
  }

  static styles = css`
    :host {
      display: block;
    }
    .panel {
      position: fixed;
      top: 80px;
      right: 16px;
      width: 360px;
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
    .divider {
      border: none;
      border-top: 1px solid #2c2c2c;
      margin: 8px 0;
    }
    .group-header {
      color: #9ca3af;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 10px 0 4px 0;
    }
    .ship-row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 4px;
      padding: 6px;
      border: 1px solid #2c2c2c;
      border-radius: 4px;
      margin-bottom: 6px;
      cursor: pointer;
    }
    .ship-row:hover {
      border-color: #444;
      background: #242424;
    }
    .ship-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ship-name {
      font-weight: bold;
    }
    .ship-status {
      color: #9ca3af;
      font-size: 11px;
    }
    .hp-bar {
      height: 6px;
      background: #2c2c2c;
      border-radius: 3px;
      overflow: hidden;
    }
    .hp-fill {
      height: 100%;
      transition: width 0.2s;
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
      width: 100%;
    }
    button:hover:not(:disabled) {
      background: #3a3a3a;
      border-color: #666;
    }
    .empty {
      color: #9ca3af;
      padding: 16px 0;
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
      >
        <div class="header">
          <span class="title">
            FLEET${me ? " — " + me.displayName() : ""}
          </span>
          <button @click=${() => this.hide()}>✕</button>
        </div>
        <hr class="divider" />
        ${groups.size === 0
          ? html`<div class="empty">No ships in fleet</div>`
          : Array.from(groups.entries()).map(
              ([type, list]) => html`
                <div class="group-header">
                  ${groupHeader(type)} (${list.length})
                </div>
                ${list.map((ship) => this.renderShipRow(ship))}
              `,
            )}
      </div>
    `;
  }

  private renderShipRow(ship: UnitView) {
    const info = this.game.config().unitInfo(ship.type());
    const maxHp = Number(info.maxHealth ?? 1);
    const pct = Math.max(
      0,
      Math.min(100, Math.round((ship.health() / maxHp) * 100)),
    );
    const currentMission = ship.mission();
    const options = BASE_OPTIONS;
    return html`
      <div class="ship-row" @click=${() => this.onFocus(ship)}>
        <div class="ship-head">
          <span class="ship-name">
            ${shipTypeLabel(ship.type())} #${ship.id()}
          </span>
          <span class="ship-status">${statusText(currentMission)}</span>
        </div>
        <div class="hp-bar">
          <div
            class="hp-fill"
            style="width: ${pct}%; background: ${this.hpColor(pct)}"
          ></div>
        </div>
        <div class="ship-status">HP ${pct}%</div>
        <select
          @click=${(e: MouseEvent) => e.stopPropagation()}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            this.onMissionChange(ship, v);
            (e.target as HTMLSelectElement).value = "";
          }}
        >
          <option value="">Set mission…</option>
          ${options.map((o) => {
            const applies = missionApplies(o, ship.type());
            return html`
              <option value=${o.mission} ?disabled=${!applies}>
                ${o.label}${currentMission === o.mission ? " ✓" : ""}
                ${applies ? "" : " (N/A)"}
              </option>
            `;
          })}
        </select>
      </div>
    `;
  }
}
