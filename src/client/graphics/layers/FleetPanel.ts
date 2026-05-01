import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
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

const boatIcon = assetUrl("images/BoatIconWhite.svg");
const anchorIcon = assetUrl("images/AnchorIcon.svg");

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
  { label: "Hold position", mission: UnitMission.HOLD_POSITION },
  {
    label: "Attack ship",
    mission: UnitMission.ATTACK_SHIP,
    needsTarget: true,
    targetingLabel: "Select enemy ship",
    specialAttackShip: true,
    targetingMode: "ship-attack",
  },
  {
    label: "Hunt submarine →",
    mission: UnitMission.HUNT_SUBMARINE,
    needsTarget: true,
    targetingLabel: "Select enemy submarine to hunt",
    specialAttackShip: true,
    targetingMode: "ship-attack",
    onlyFor: [UnitType.Destroyer],
  },
  {
    label: "Hunt submarine",
    mission: UnitMission.HUNT_SUBMARINE,
    needsTarget: true,
    targetingLabel: "Select enemy submarine",
    specialHuntSubmarine: true,
    onlyFor: [UnitType.Destroyer, UnitType.Submarine],
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
    const ports = this.blockadedPorts();
    if (ports.length === 0) return;

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

  private renderNoPortIcon() {
    return html`<span
      class="relative inline-flex h-5 w-5 items-center justify-center rounded border border-red-500/70 bg-red-950/80"
      title="No port"
    >
      <img src=${anchorIcon} alt="" class="h-3.5 w-3.5 invert opacity-90" />
      <span
        class="absolute -right-1 -top-1 text-[12px] font-black leading-none text-red-300"
        >x</span
      >
    </span>`;
  }

  render() {
    if (this._hidden) return html``;
    const me = this.game.myPlayer();
    const ships = this.getShips();
    const groups = this.groupShips(ships);

    return html`
      <div
        class="fixed right-4 top-20 z-[950] max-h-[calc(100vh-120px)] w-[360px] overflow-hidden rounded-2xl bg-zinc-900/95 text-zinc-100 shadow-2xl shadow-black/50 ring-1 ring-white/10 pointer-events-auto font-sans antialiased"
        @mousedown=${(e: MouseEvent) => e.stopPropagation()}
        @click=${(e: MouseEvent) => e.stopPropagation()}
        @wheel=${(e: WheelEvent) => e.stopPropagation()}
      >
        <div
          class="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-zinc-900/95 px-4 py-3"
        >
          <img src=${boatIcon} alt="" class="h-5 w-5 opacity-90" />
          <div class="text-sm font-bold tracking-wide text-yellow-300">
            FLEET${me ? ` - ${me.displayName()}` : ""}
          </div>
          <button
            class="ml-auto flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-white shadow-sm transition-colors hover:bg-red-500"
            @click=${() => this.hide()}
            aria-label="Close"
            title="Close"
          >
            x
          </button>
        </div>
        <div class="max-h-[calc(100vh-178px)] overflow-y-auto px-4 py-3">
          ${groups.size === 0
            ? html`<div class="py-6 text-center text-sm text-zinc-400">
                No ships in fleet
              </div>`
            : Array.from(groups.entries()).map(
                ([type, list]) => html`
                  <div
                    class="mb-2 mt-1 text-[11px] font-bold tracking-[0.14em] text-zinc-400"
                  >
                    ${groupHeader(type)} (${list.length})
                  </div>
                  <div class="mb-3 flex flex-col gap-2">
                    ${list.map((ship, index) =>
                      this.renderShipRow(ship, index + 1),
                    )}
                  </div>
                `,
              )}
        </div>
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
      <div
        class="cursor-pointer rounded-md border border-white/10 bg-black/20 p-2 transition-colors hover:border-zinc-500 hover:bg-zinc-800/70"
        @click=${() => this.onFocus(ship)}
      >
        <div class="flex items-center gap-2">
          <button
            class="min-w-0 flex-1 truncate text-left text-sm font-bold text-white hover:text-yellow-300"
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              this.onFocus(ship);
            }}
          >
            ${shipTypeLabel(ship.type())} #${displayId}
          </button>
          ${homeless ? this.renderNoPortIcon() : ""}
          ${blockaded
            ? html`<span
                class="rounded border border-red-500/70 bg-red-950/80 px-1.5 py-0.5 text-[10px] font-bold leading-none text-red-200"
                >BLOCKADED</span
              >`
            : ""}
          <span
            class="w-9 text-right text-xs font-bold tabular-nums text-zinc-200"
            >${pct}%</span
          >
        </div>
        <div
          class="mt-1 h-2 overflow-hidden rounded bg-zinc-950 ring-1 ring-white/10"
        >
          <div
            class="h-full transition-[width] duration-200"
            style="width:${pct}%;background:${this.hpColor(pct)}"
          ></div>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <div class="min-w-0 flex-1 truncate text-xs text-zinc-400">
            ${statusText(currentMission)}
          </div>
          <select
            class="max-w-[136px] rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs font-bold text-zinc-100 hover:bg-zinc-700"
            @click=${(e: MouseEvent) => e.stopPropagation()}
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
                  ? " *"
                  : ""}${applies ? "" : " (N/A)"}
              </option>`;
            })}
          </select>
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this;
  }
}
