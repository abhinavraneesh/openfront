import { LitElement, css, html, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus, GameEvent } from "../../../core/EventBus";
import { Cell, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView, UnitView } from "../../../core/game/GameView";
import { MouseMoveEvent } from "../../InputHandler";
import {
  StartTargetingModeEvent,
  StopTargetingModeEvent,
  TargetingMode,
} from "../../Transport";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

export class TargetingCancelledEvent implements GameEvent {}

const SHIP_TYPES: UnitType[] = [
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Minelayer,
  UnitType.Warship,
  UnitType.TransportShip,
  UnitType.TradeShip,
];

@customElement("targeting-cursor")
export class TargetingCursor extends LitElement implements Layer {
  public eventBus: EventBus;
  public game: GameView;
  public transformHandler: TransformHandler;

  @state() private _active = false;
  @state() private _label = "";
  @state() private _mode: TargetingMode = "tile";
  @state() private _originScreen: { x: number; y: number } | null = null;
  @state() private _cursorScreen: { x: number; y: number } | null = null;
  @state() private _radius = 0;
  @state() private _hoverTargetScreen: { x: number; y: number } | null = null;
  @state() private _hoverValid = false;
  @state() private _inRange = true;
  @state() private _valid = true;
  @state() private _mx = 0;
  @state() private _my = 0;

  private _originTile: TileRef | undefined = undefined;
  private _rangeTiles: number | undefined = undefined;
  private _mouseX = 0;
  private _mouseY = 0;
  private _validator: ((tile: TileRef) => boolean) | undefined = undefined;

  private _onMouseMove = (e: MouseEvent) => {
    this._mouseX = e.clientX;
    this._mouseY = e.clientY;
    this._mx = e.clientX;
    this._my = e.clientY;
  };

  init() {
    this.eventBus.on(StartTargetingModeEvent, (e) => {
      this._active = true;
      this._label = e.label;
      this._originTile = e.originTile;
      this._rangeTiles = e.rangeTiles;
      this._mode = e.mode;
      this._validator = e.isValidTarget;
      document.body.classList.add("targeting-active");
      window.addEventListener("mousemove", this._onMouseMove);
    });
    this.eventBus.on(StopTargetingModeEvent, () => {
      this._active = false;
      this._label = "";
      this._originTile = undefined;
      this._rangeTiles = undefined;
      this._originScreen = null;
      this._cursorScreen = null;
      this._hoverTargetScreen = null;
      this._validator = undefined;
      document.body.classList.remove("targeting-active");
      window.removeEventListener("mousemove", this._onMouseMove);
    });
    this.eventBus.on(MouseMoveEvent, (e) => {
      if (!this._active || !this.game || !this.transformHandler) return;
      this._mx = e.x;
      this._my = e.y;
      if (this._validator === undefined) {
        this._valid = true;
        return;
      }
      const cell = this.transformHandler.screenToWorldCoordinates(e.x, e.y);
      this._valid =
        this.game.isValidCoord(cell.x, cell.y) &&
        this._validator(this.game.ref(cell.x, cell.y));
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._active) {
        this._active = false;
        this._label = "";
        this._originTile = undefined;
        this._rangeTiles = undefined;
        this._originScreen = null;
        this._cursorScreen = null;
        this._hoverTargetScreen = null;
        this._validator = undefined;
        document.body.classList.remove("targeting-active");
        window.removeEventListener("mousemove", this._onMouseMove);
        this.eventBus.emit(new StopTargetingModeEvent());
        this.eventBus.emit(new TargetingCancelledEvent());
      }
    });
  }

  tick() {
    if (!this._active || !this.game || !this.transformHandler) return;

    // Origin (ship position) — fixed while targeting active.
    if (this._originTile !== undefined) {
      const oc = new Cell(
        this.game.x(this._originTile),
        this.game.y(this._originTile),
      );
      this._originScreen = this.transformHandler.worldToScreenCoordinates(oc);
      this._radius = (this._rangeTiles ?? 0) * this.transformHandler.scale;
    } else {
      this._originScreen = null;
      this._radius = 0;
    }

    // Cursor position — update from last mouse event.
    this._cursorScreen = { x: this._mouseX, y: this._mouseY };

    // World tile under cursor.
    const worldCell = this.transformHandler.screenToWorldCoordinates(
      this._mouseX,
      this._mouseY,
    );
    let cursorTile: TileRef | undefined;
    if (this.game.isValidCoord(worldCell.x, worldCell.y)) {
      cursorTile = this.game.ref(worldCell.x, worldCell.y);
    }

    // Range check.
    if (
      cursorTile !== undefined &&
      this._originTile !== undefined &&
      this._rangeTiles !== undefined
    ) {
      const d = this.game.manhattanDist(this._originTile, cursorTile);
      this._inRange = d <= this._rangeTiles;
    } else {
      this._inRange = true;
    }

    // Hover-target reticle for ship modes.
    this._hoverTargetScreen = null;
    this._hoverValid = false;
    if (
      cursorTile !== undefined &&
      (this._mode === "ship-attack" || this._mode === "ship-escort")
    ) {
      const me = this.game.myPlayer();
      const myId = me?.id();
      const candidates = this.game.nearbyUnits(cursorTile, 6, SHIP_TYPES);
      let best: UnitView | undefined;
      let bestDist = Infinity;
      for (const { unit, distSquared } of candidates) {
        if (!unit.isActive()) continue;
        const ownerId = unit.owner().id();
        if (this._mode === "ship-attack") {
          if (myId !== undefined && ownerId === myId) continue;
        } else {
          if (myId === undefined || ownerId !== myId) continue;
          if (
            this._originTile !== undefined &&
            unit.tile() === this._originTile
          )
            continue;
        }
        if (distSquared < bestDist) {
          best = unit;
          bestDist = distSquared;
        }
      }
      if (best) {
        const c = new Cell(this.game.x(best.tile()), this.game.y(best.tile()));
        this._hoverTargetScreen =
          this.transformHandler.worldToScreenCoordinates(c);
        this._hoverValid = true;
      }
    }
  }

  static styles = css`
    :host {
      display: block;
      pointer-events: none;
    }
    .targeting-overlay {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 900;
      overflow: hidden;
    }
    .targeting-bar {
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.82);
      border: 1px solid #facc15;
      border-radius: 6px;
      padding: 8px 18px;
      color: #facc15;
      font-family: monospace;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 16px;
      pointer-events: none;
      white-space: nowrap;
    }
    .cancel-hint {
      color: #9ca3af;
      font-size: 11px;
    }
    .out-of-range {
      color: #ef4444;
    }
    @keyframes reticle-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
    .reticle {
      position: fixed;
      width: 22px;
      height: 22px;
      transform: translate(-50%, -50%);
      border: 1px solid currentColor;
      border-radius: 50%;
      color: #22c55e;
      box-shadow: 0 0 10px currentColor;
    }
    .reticle::before,
    .reticle::after {
      content: "";
      position: absolute;
      background: currentColor;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }
    .reticle::before {
      width: 30px;
      height: 1px;
    }
    .reticle::after {
      width: 1px;
      height: 30px;
    }
    .reticle.invalid {
      color: #ef4444;
    }
  `;

  private renderRangeRing() {
    if (
      this._rangeTiles === undefined ||
      this._originScreen === null ||
      this._radius <= 0
    )
      return svg``;
    return svg`
      <circle
        cx=${this._originScreen.x}
        cy=${this._originScreen.y}
        r=${this._radius}
        fill="rgba(250,204,21,0.06)"
        stroke="#facc15"
        stroke-width="1.5"
        stroke-dasharray="10 6"
        stroke-opacity="0.7"
      />
    `;
  }

  private renderMovementLine() {
    if (
      this._originScreen === null ||
      this._cursorScreen === null ||
      (this._mode !== "move" &&
        this._mode !== "bombard" &&
        this._mode !== "mine")
    )
      return svg``;
    const stroke = this._inRange ? "#22c55e" : "#ef4444";
    return svg`
      <line
        x1=${this._originScreen.x}
        y1=${this._originScreen.y}
        x2=${this._cursorScreen.x}
        y2=${this._cursorScreen.y}
        stroke=${stroke}
        stroke-width="2"
        stroke-dasharray="8 5"
        stroke-opacity="0.85"
      />
      <circle
        cx=${this._cursorScreen.x}
        cy=${this._cursorScreen.y}
        r="6"
        fill="none"
        stroke=${stroke}
        stroke-width="2"
      />
    `;
  }

  private renderShipReticle() {
    if (
      (this._mode !== "ship-attack" && this._mode !== "ship-escort") ||
      this._cursorScreen === null
    )
      return svg``;

    if (this._hoverTargetScreen && this._hoverValid) {
      const color = this._mode === "ship-attack" ? "#ef4444" : "#22c55e";
      const cx = this._hoverTargetScreen.x;
      const cy = this._hoverTargetScreen.y;
      return svg`
        <g style="transform-origin: ${cx}px ${cy}px; animation: reticle-spin 4s linear infinite">
          <circle cx=${cx} cy=${cy} r="22" fill="none" stroke=${color} stroke-width="2.5" />
          <line x1=${cx - 30} y1=${cy} x2=${cx - 14} y2=${cy} stroke=${color} stroke-width="2.5" />
          <line x1=${cx + 14} y1=${cy} x2=${cx + 30} y2=${cy} stroke=${color} stroke-width="2.5" />
          <line x1=${cx} y1=${cy - 30} x2=${cx} y2=${cy - 14} stroke=${color} stroke-width="2.5" />
          <line x1=${cx} y1=${cy + 14} x2=${cx} y2=${cy + 30} stroke=${color} stroke-width="2.5" />
        </g>
      `;
    }

    // No valid target under cursor — small grey crosshair on cursor.
    const cx = this._cursorScreen.x;
    const cy = this._cursorScreen.y;
    return svg`
      <circle cx=${cx} cy=${cy} r="10" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="3 3" />
    `;
  }

  render() {
    if (!this._active) return html``;
    return html`
      <div class="targeting-overlay">
        <div
          class=${`reticle ${this._valid ? "" : "invalid"}`}
          style="left:${this._mx}px;top:${this._my}px"
        ></div>
        <svg
          style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"
        >
          ${this.renderRangeRing()} ${this.renderMovementLine()}
          ${this.renderShipReticle()}
        </svg>
      </div>
      <div class="targeting-bar">
        <span>${this._label}</span>
        ${this._rangeTiles !== undefined
          ? html`<span
              class="cancel-hint ${this._inRange ? "" : "out-of-range"}"
              >Range: ${this._rangeTiles}
              tiles${this._inRange ? "" : " — out of range"}</span
            >`
          : ""}
        <span class="cancel-hint">[Esc] to cancel</span>
      </div>
    `;
  }
}
