import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus, GameEvent } from "../../../core/EventBus";
import {
  StartTargetingModeEvent,
  StopTargetingModeEvent,
} from "../../Transport";
import { Layer } from "./Layer";

export class TargetingCancelledEvent implements GameEvent {}

@customElement("targeting-cursor")
export class TargetingCursor extends LitElement implements Layer {
  public eventBus: EventBus;

  @state() private _active = false;
  @state() private _label = "";

  init() {
    this.eventBus.on(StartTargetingModeEvent, (e) => {
      this._active = true;
      this._label = e.label;
      document.body.classList.add("targeting-active");
    });
    this.eventBus.on(StopTargetingModeEvent, () => {
      this._active = false;
      this._label = "";
      document.body.classList.remove("targeting-active");
    });

    // Cancel on Escape key
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._active) {
        this._active = false;
        this._label = "";
        document.body.classList.remove("targeting-active");
        this.eventBus.emit(new StopTargetingModeEvent());
        this.eventBus.emit(new TargetingCancelledEvent());
      }
    });
  }

  tick() {}

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
  `;

  render() {
    if (!this._active) return html``;
    return html`
      <div class="targeting-overlay"></div>
      <div class="targeting-bar">
        <span>${this._label}</span>
        <span class="cancel-hint">[Esc] to cancel</span>
      </div>
    `;
  }
}
