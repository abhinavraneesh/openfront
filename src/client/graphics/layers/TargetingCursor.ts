import { LitElement, css, html, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus, GameEvent } from "../../../core/EventBus";
import { Cell } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameView } from "../../../core/game/GameView";
import { MouseMoveEvent } from "../../InputHandler";
import {
  StartTargetingModeEvent,
  StopTargetingModeEvent,
} from "../../Transport";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

export class TargetingCancelledEvent implements GameEvent {}

@customElement("targeting-cursor")
export class TargetingCursor extends LitElement implements Layer {
  public eventBus: EventBus;
  public game: GameView;
  public transformHandler: TransformHandler;

  @state() private _active = false;
  @state() private _label = "";
  @state() private _cx = 0;
  @state() private _cy = 0;
  @state() private _radius = 0;
  @state() private _valid = true;
  @state() private _mx = 0;
  @state() private _my = 0;

  private _originTile: TileRef | undefined = undefined;
  private _rangeTiles: number | undefined = undefined;
  private _validator: ((tile: TileRef) => boolean) | undefined = undefined;

  init() {
    this.eventBus.on(StartTargetingModeEvent, (e) => {
      this._active = true;
      this._label = e.label;
      this._originTile = e.originTile;
      this._rangeTiles = e.rangeTiles;
      this._validator = e.isValidTarget;
      document.body.classList.add("targeting-active");
    });
    this.eventBus.on(StopTargetingModeEvent, () => {
      this._active = false;
      this._label = "";
      this._originTile = undefined;
      this._rangeTiles = undefined;
      this._validator = undefined;
      document.body.classList.remove("targeting-active");
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

    // Cancel on Escape key
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._active) {
        this._active = false;
        this._label = "";
        this._originTile = undefined;
        this._rangeTiles = undefined;
        this._validator = undefined;
        document.body.classList.remove("targeting-active");
        this.eventBus.emit(new StopTargetingModeEvent());
        this.eventBus.emit(new TargetingCancelledEvent());
      }
    });
  }

  tick() {
    if (
      !this._active ||
      this._originTile === undefined ||
      this._rangeTiles === undefined ||
      !this.game ||
      !this.transformHandler
    ) {
      return;
    }
    const cell = new Cell(
      this.game.x(this._originTile),
      this.game.y(this._originTile),
    );
    const screen = this.transformHandler.worldToScreenCoordinates(cell);
    const radius = this._rangeTiles * this.transformHandler.scale;
    if (
      screen.x !== this._cx ||
      screen.y !== this._cy ||
      radius !== this._radius
    ) {
      this._cx = screen.x;
      this._cy = screen.y;
      this._radius = radius;
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
      /* pointer-events: none so the click reaches the canvas below — the
         crosshair cursor is applied to <body> via .targeting-active. */
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

  render() {
    if (!this._active) return html``;
    const hasRange =
      this._rangeTiles !== undefined && this._originTile !== undefined;
    return html`
      <div class="targeting-overlay">
        <div
          class=${`reticle ${this._valid ? "" : "invalid"}`}
          style="left:${this._mx}px;top:${this._my}px"
        ></div>
        ${hasRange
          ? html`<svg
              style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"
            >
              ${svg`
              <circle
                cx=${this._cx}
                cy=${this._cy}
                r=${this._radius}
                fill="rgba(250,204,21,0.06)"
                stroke="#facc15"
                stroke-width="1.5"
                stroke-dasharray="10 6"
                stroke-opacity="0.7"
              />
            `}
            </svg>`
          : ""}
      </div>
      <div class="targeting-bar">
        <span>${this._label}</span>
        ${hasRange
          ? html`<span class="cancel-hint"
              >Range: ${this._rangeTiles} tiles</span
            >`
          : ""}
        <span class="cancel-hint">[Esc] to cancel</span>
      </div>
    `;
  }
}
