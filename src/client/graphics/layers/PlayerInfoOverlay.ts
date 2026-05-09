import { html, LitElement, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import {
  PlayerProfile,
  PlayerType,
  Relation,
  Unit,
  UnitType,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { AllianceView } from "../../../core/game/GameUpdates";
import { GameView, PlayerView, UnitView } from "../../../core/game/GameView";
import {
  ContextMenuEvent,
  MouseMoveEvent,
  TouchEvent,
} from "../../InputHandler";
import {
  getTranslatedPlayerTeamLabel,
  renderDuration,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import {
  EMOJI_ICON_KIND,
  getFirstPlacePlayer,
  getPlayerIcons,
  IMAGE_ICON_KIND,
} from "../PlayerIcons";
import { TransformHandler } from "../TransformHandler";
import { ImmunityBarVisibleEvent } from "./ImmunityTimer";
import { Layer } from "./Layer";
import { CloseRadialMenuEvent } from "./RadialMenu";
import { SpawnBarVisibleEvent } from "./SpawnTimer";
const allianceIcon = assetUrl("images/AllianceIcon.svg");
const warshipIcon = assetUrl("images/BattleshipIconWhite.svg");
const cityIcon = assetUrl("images/CityIconWhite.svg");
const factoryIcon = assetUrl("images/FactoryIconWhite.svg");
const goldCoinIcon = assetUrl("images/GoldCoinIcon.svg");
const missileSiloIcon = assetUrl("images/MissileSiloIconWhite.svg");
const portIcon = assetUrl("images/PortIcon.svg");
const samLauncherIcon = assetUrl("images/SamLauncherIconWhite.svg");
const soldierIcon = assetUrl("images/SoldierIcon.svg");
const airbaseIcon = assetUrl("images/AirbaseIconWhite.svg");
const navalYardIcon = assetUrl("images/NavalYardIconWhite.svg");
const destroyerIcon = assetUrl("images/DestroyerIconWhite.svg");
const boatIcon = assetUrl("images/BoatIconWhite.svg");
const swordIcon = assetUrl("images/SwordIconWhite.svg");
const explosionIcon = assetUrl("images/ExplosionIconWhite.svg");

function euclideanDistWorld(
  coord: { x: number; y: number },
  tileRef: TileRef,
  game: GameView,
): number {
  const x = game.x(tileRef);
  const y = game.y(tileRef);
  const dx = coord.x - x;
  const dy = coord.y - y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distSortUnitWorld(coord: { x: number; y: number }, game: GameView) {
  return (a: Unit | UnitView, b: Unit | UnitView) => {
    const distA = euclideanDistWorld(coord, a.tile(), game);
    const distB = euclideanDistWorld(coord, b.tile(), game);
    return distA - distB;
  };
}

@customElement("player-info-overlay")
export class PlayerInfoOverlay extends LitElement implements Layer {
  @property({ type: Object })
  public game!: GameView;

  @property({ type: Object })
  public eventBus!: EventBus;

  @property({ type: Object })
  public transform!: TransformHandler;

  @state()
  private player: PlayerView | null = null;

  @state()
  private playerProfile: PlayerProfile | null = null;

  @state()
  private unit: UnitView | null = null;

  @state()
  private _isInfoVisible: boolean = false;

  @state()
  private spawnBarVisible = false;
  @state()
  private immunityBarVisible = false;

  private _isActive = false;

  private get barOffset(): number {
    return (this.spawnBarVisible ? 7 : 0) + (this.immunityBarVisible ? 7 : 0);
  }

  private lastMouseUpdate = 0;

  init() {
    this.eventBus.on(MouseMoveEvent, (e: MouseMoveEvent) =>
      this.onMouseEvent(e),
    );
    this.eventBus.on(ContextMenuEvent, (e: ContextMenuEvent) =>
      this.maybeShow(e.x, e.y),
    );
    this.eventBus.on(TouchEvent, (e: TouchEvent) => this.maybeShow(e.x, e.y));
    this.eventBus.on(CloseRadialMenuEvent, () => this.hide());
    this.eventBus.on(SpawnBarVisibleEvent, (e) => {
      this.spawnBarVisible = e.visible;
    });
    this.eventBus.on(ImmunityBarVisibleEvent, (e) => {
      this.immunityBarVisible = e.visible;
    });
    this._isActive = true;
  }

  private onMouseEvent(event: MouseMoveEvent) {
    const now = Date.now();
    if (now - this.lastMouseUpdate < 100) {
      return;
    }
    this.lastMouseUpdate = now;
    this.maybeShow(event.x, event.y);
  }

  public hide() {
    this.setVisible(false);
    this.unit = null;
    this.player = null;
  }

  public maybeShow(x: number, y: number) {
    this.hide();
    const worldCoord = this.transform.screenToWorldCoordinates(x, y);
    if (!this.game.isValidCoord(worldCoord.x, worldCoord.y)) {
      return;
    }

    const tile = this.game.ref(worldCoord.x, worldCoord.y);
    if (!tile) return;

    const owner = this.game.owner(tile);

    if (owner && owner.isPlayer()) {
      this.player = owner as PlayerView;
      this.player.profile().then((p) => {
        this.playerProfile = p;
      });
      this.setVisible(true);
    } else if (!this.game.isLand(tile)) {
      const units = this.game
        .units(
          UnitType.Warship,
          UnitType.Destroyer,
          UnitType.Cruiser,
          UnitType.Battleship,
          UnitType.Submarine,
          UnitType.Minelayer,
          UnitType.Fighter,
          UnitType.Bomber,
          UnitType.AttackHelicopter,
          UnitType.Carrier,
          UnitType.TradeShip,
          UnitType.TransportShip,
        )
        .filter((u) => euclideanDistWorld(worldCoord, u.tile(), this.game) < 50)
        .sort(distSortUnitWorld(worldCoord, this.game));

      if (units.length > 0) {
        this.unit = units[0];
        this.setVisible(true);
      }
    }
  }

  tick() {
    this.requestUpdate();
  }

  renderLayer(context: CanvasRenderingContext2D) {
    // Implementation for Layer interface
  }

  shouldTransform(): boolean {
    return false;
  }

  setVisible(visible: boolean) {
    this._isInfoVisible = visible;
    this.requestUpdate();
  }

  private getPlayerNameColor(
    player: PlayerView,
    myPlayer: PlayerView | null | undefined,
    isFriendly: boolean,
  ): string {
    if (isFriendly) return "text-green-500";
    if (
      myPlayer &&
      myPlayer !== player &&
      player.type() === PlayerType.Nation
    ) {
      const relation =
        this.playerProfile?.relations[myPlayer.smallID()] ?? Relation.Neutral;
      return this.getRelationClass(relation);
    }
    return "text-white";
  }

  private getRelationClass(relation: Relation): string {
    switch (relation) {
      case Relation.Hostile:
        return "text-red-500";
      case Relation.Distrustful:
        return "text-red-300";
      case Relation.Neutral:
        return "text-white";
      case Relation.Friendly:
        return "text-green-500";
      default:
        return "text-white";
    }
  }

  private getRelationName(relation: Relation): string {
    switch (relation) {
      case Relation.Hostile:
        return translateText("relation.hostile");
      case Relation.Distrustful:
        return translateText("relation.distrustful");
      case Relation.Neutral:
        return translateText("relation.neutral");
      case Relation.Friendly:
        return translateText("relation.friendly");
      default:
        return translateText("relation.default");
    }
  }

  private displayUnitCount(player: PlayerView, type: UnitType, icon: string) {
    return !this.game.config().isUnitDisabled(type)
      ? html`<div
          class="flex items-center justify-center gap-0.5 lg:gap-1 p-0.5 lg:p-1 border rounded-md border-gray-500 text-[10px] lg:text-xs w-9 lg:w-12 h-6 lg:h-7"
          translate="no"
        >
          <img
            src=${icon}
            class="w-3 h-3 lg:w-4 lg:h-4 object-contain shrink-0"
          />
          <span>${player.totalUnitLevels(type)}</span>
        </div>`
      : "";
  }

  private allianceExpirationText(alliance: AllianceView) {
    const { expiresAt } = alliance;
    const remainingTicks = expiresAt - this.game.ticks();
    let remainingSeconds = 0;
    if (remainingTicks > 0) {
      remainingSeconds = Math.max(0, Math.floor(remainingTicks / 10)); // 10 ticks per second
    }
    return renderDuration(remainingSeconds);
  }

  private renderPlayerNameIcons(player: PlayerView) {
    const firstPlace = getFirstPlacePlayer(this.game);
    const icons = getPlayerIcons({
      game: this.game,
      player,
      // Because we already show the alliance icon next to the alliance expiration timer, we don't need to show it a second time in this render
      includeAllianceIcon: false,
      firstPlace,
      alliancesDisabled: this.game.config().disableAlliances(),
    });

    if (icons.length === 0) {
      return html``;
    }

    return html`<span class="flex items-center gap-1 ml-1 shrink-0">
      ${icons.map((icon) =>
        icon.kind === EMOJI_ICON_KIND && icon.text
          ? html`<span class="text-sm shrink-0" translate="no"
              >${icon.text}</span
            >`
          : icon.kind === IMAGE_ICON_KIND && icon.src
            ? html`<img src=${icon.src} alt="" class="w-4 h-4 shrink-0" />`
            : html``,
      )}
    </span>`;
  }

  private renderPlayerInfo(player: PlayerView) {
    const myPlayer = this.game.myPlayer();
    const isFriendly = myPlayer?.isFriendly(player);
    const isAllied = myPlayer?.isAlliedWith(player);
    let allianceHtml: TemplateResult | null = null;
    const maxTroops = this.game.config().maxTroops(player);
    const attackingTroops = player
      .outgoingAttacks()
      .map((a) => a.troops)
      .reduce((a, b) => a + b, 0);
    const totalTroops = player.troops();

    if (isAllied) {
      const alliance = myPlayer
        ?.alliances()
        .find((alliance) => alliance.other === player.id());
      if (alliance !== undefined) {
        allianceHtml = html` <div
          class="flex items-center ml-auto mr-0 gap-1 text-sm font-bold leading-tight"
        >
          <img src=${allianceIcon} width="20" height="20" />
          ${this.allianceExpirationText(alliance)}
        </div>`;
      }
    }
    let playerType = "";
    switch (player.type()) {
      case PlayerType.Bot:
        playerType = translateText("player_type.bot");
        break;
      case PlayerType.Nation:
        playerType = translateText("player_type.nation");
        break;
      case PlayerType.Human:
        playerType = translateText("player_type.player");
        break;
    }
    const playerTeam = getTranslatedPlayerTeamLabel(player.team());

    return html`
      <div class="flex items-start gap-1 lg:gap-2 p-1 lg:p-1.5">
        <!-- Left: Gold & Troop bar -->
        <div class="flex flex-col gap-1 shrink-0 w-28 md:w-36">
          <div class="flex items-center gap-1">
            <div
              class="flex flex-1 items-center justify-center px-1 py-0.5 border rounded-md border-yellow-400 font-bold text-yellow-400 text-sm lg:gap-1"
              translate="no"
            >
              <img src=${goldCoinIcon} width="13" height="13" />
              <span class="px-0.5">${renderNumber(player.gold())}</span>
            </div>
            <div
              class="flex flex-1 flex-col items-center justify-center text-xs font-bold ${attackingTroops >
              0
                ? "text-sky-400"
                : "text-white/40"} drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
              translate="no"
            >
              <span class="flex items-center gap-px leading-none text-xs"
                ><img
                  src=${soldierIcon}
                  class="w-2.5 h-2.5"
                  style="${attackingTroops > 0
                    ? "filter: brightness(0) saturate(100%) invert(62%) sepia(80%) saturate(500%) hue-rotate(175deg) brightness(100%); opacity:1"
                    : "filter: brightness(0) invert(1); opacity:0.4"}"
                />↑</span
              >
              <span class="tabular-nums leading-none text-sm mt-0.5"
                >${renderTroops(attackingTroops)}</span
              >
            </div>
          </div>
          <div class="w-28 md:w-36" translate="no">
            ${this.renderTroopBar(totalTroops, attackingTroops, maxTroops)}
          </div>
        </div>
        <!-- Right: Player identity + Units below -->
        <div class="flex flex-col justify-between self-stretch">
          <div
            class="flex items-center gap-2 font-bold text-sm lg:text-lg ${this.getPlayerNameColor(
              player,
              myPlayer,
              isFriendly ?? false,
            )}"
          >
            ${player.cosmetics.flag
              ? html`<img
                  class="h-6 object-contain"
                  src=${assetUrl(player.cosmetics.flag!)}
                />`
              : html``}
            <span>${player.displayName()}</span>
            ${playerTeam !== "" && player.type() !== PlayerType.Bot
              ? html`<div class="flex flex-col leading-tight">
                  <span class="text-gray-400 text-xs font-normal"
                    >${playerType}</span
                  >
                  <span class="text-xs font-normal text-gray-400"
                    >[<span
                      style="color: ${this.game
                        .config()
                        .theme()
                        .teamColor(player.team()!)
                        .toHex()}"
                      >${playerTeam}</span
                    >]</span
                  >
                </div>`
              : html`<span class="text-gray-400 text-xs font-normal"
                  >${playerType}</span
                >`}
            ${this.renderPlayerNameIcons(player)} ${allianceHtml ?? ""}
          </div>
          <div class="flex gap-0.5 lg:gap-1 items-center mt-0.5">
            ${this.displayUnitCount(player, UnitType.City, cityIcon)}
            ${this.displayUnitCount(player, UnitType.Factory, factoryIcon)}
            ${this.displayUnitCount(player, UnitType.Port, portIcon)}
            ${this.displayUnitCount(
              player,
              UnitType.MissileSilo,
              missileSiloIcon,
            )}
            ${this.displayUnitCount(
              player,
              UnitType.SAMLauncher,
              samLauncherIcon,
            )}
            ${this.displayUnitCount(player, UnitType.Warship, warshipIcon)}
            ${this.displayUnitCount(player, UnitType.NavalYard, navalYardIcon)}
            ${this.displayUnitCount(player, UnitType.Airbase, airbaseIcon)}
          </div>
        </div>
      </div>
    `;
  }

  private renderTroopBar(
    totalTroops: number,
    attackingTroops: number,
    maxTroops: number,
  ) {
    const base = Math.max(maxTroops, 1);
    const greenPercentRaw = (totalTroops / base) * 100;
    const orangePercentRaw = (attackingTroops / base) * 100;

    const greenPercent = Math.max(0, Math.min(100, greenPercentRaw));
    const orangePercent = Math.max(
      0,
      Math.min(100 - greenPercent, orangePercentRaw),
    );

    return html`
      <div
        class="w-full h-5 lg:h-6 border border-gray-600 rounded-md bg-gray-900/60 overflow-hidden relative"
      >
        <div class="h-full flex">
          ${greenPercent > 0
            ? html`<div
                class="h-full bg-sky-700 transition-[width] duration-200"
                style="width: ${greenPercent}%;"
              ></div>`
            : ""}
          ${orangePercent > 0
            ? html`<div
                class="h-full bg-[#0073b7] transition-[width] duration-200"
                style="width: ${orangePercent}%;"
              ></div>`
            : ""}
        </div>
        <div
          class="absolute inset-0 flex items-center justify-between px-1.5 text-sm font-bold leading-none pointer-events-none"
          translate="no"
        >
          <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >${renderTroops(totalTroops)}</span
          >
          <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >${renderTroops(maxTroops)}</span
          >
        </div>
        <img
          src=${soldierIcon}
          alt=""
          aria-hidden="true"
          width="14"
          height="14"
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 brightness-0 invert drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] pointer-events-none"
        />
      </div>
    `;
  }

  private unitTypeIcon(type: UnitType): string | null {
    switch (type) {
      case UnitType.Destroyer:
        return destroyerIcon;
      case UnitType.Cruiser:
      case UnitType.Battleship:
      case UnitType.Carrier:
      case UnitType.Warship:
        return warshipIcon;
      case UnitType.Submarine:
      case UnitType.Minelayer:
      case UnitType.TransportShip:
        return boatIcon;
      case UnitType.NavalYard:
        return navalYardIcon;
      case UnitType.Airbase:
        return airbaseIcon;
      case UnitType.Factory:
        return factoryIcon;
      case UnitType.CoastalBattery:
      case UnitType.SAMLauncher:
        return samLauncherIcon;
      case UnitType.Fighter:
      case UnitType.AttackHelicopter:
        return swordIcon;
      case UnitType.Bomber:
        return explosionIcon;
      case UnitType.City:
        return cityIcon;
      case UnitType.MissileSilo:
        return missileSiloIcon;
      case UnitType.Port:
        return portIcon;
      default:
        return null;
    }
  }

  private unitTypeName(type: UnitType): string {
    const key = "unit_type." + type.toLowerCase().replace(/\s+/g, "_");
    const translated = translateText(key);
    return translated !== key ? translated : type;
  }

  private renderHealthBar(unit: UnitView): TemplateResult {
    const maxHealth =
      this.game.config().unitInfo(unit.type()).maxHealth ?? 1000;
    const pct = Math.max(0, Math.min(100, (unit.health() / maxHealth) * 100));
    const color =
      pct > 50 ? "bg-green-500" : pct > 25 ? "bg-yellow-400" : "bg-red-500";
    return html`
      <div class="mt-1">
        <div class="flex items-center gap-1">
          <div class="flex-1 h-2 bg-gray-600 rounded-full overflow-hidden">
            <div
              class="${color} h-full rounded-full transition-all"
              style="width:${pct}%"
            ></div>
          </div>
          <span class="text-xs opacity-70 w-12 text-right"
            >${unit.health()}/${maxHealth}</span
          >
        </div>
      </div>
    `;
  }

  private renderAircraftCounts(base: UnitView): TemplateResult {
    const owner = base.owner();
    const AIRCRAFT: Array<{ unitType: UnitType; label: string }> = [
      { unitType: UnitType.Fighter, label: translateText("unit_type.fighter") },
      {
        unitType: UnitType.Bomber,
        label: translateText("unit_type.bomber"),
      },
      {
        unitType: UnitType.AttackHelicopter,
        label: translateText("unit_type.attack_helicopter"),
      },
    ];
    const rows = AIRCRAFT.map(({ unitType, label }) => {
      const count = this.game
        .units(unitType)
        .filter((u) => u.owner() === owner).length;
      return html`
        <div class="flex justify-between text-xs py-0.5">
          <span class="opacity-70">${label}</span>
          <span class="font-mono">${count}</span>
        </div>
      `;
    });
    return html`
      <div class="mt-2 border-t border-gray-600 pt-1">
        <div class="text-xs font-semibold opacity-60 mb-1">Aircraft</div>
        ${rows}
      </div>
    `;
  }

  private renderUnitInfo(unit: UnitView) {
    const isAlly =
      (unit.owner() === this.game.myPlayer() ||
        this.game.myPlayer()?.isFriendly(unit.owner())) ??
      false;

    const icon = this.unitTypeIcon(unit.type());
    const name = this.unitTypeName(unit.type());
    const isOwnBase =
      unit.owner() === this.game.myPlayer() &&
      (unit.type() === UnitType.Airbase || unit.type() === UnitType.Carrier);

    return html`
      <div class="p-2">
        <div class="font-bold mb-1 ${isAlly ? "text-green-500" : "text-white"}">
          ${unit.owner().displayName()}
        </div>
        <div class="mt-1">
          <div class="flex items-center gap-1.5 text-sm opacity-90">
            ${icon
              ? html`<img
                  src=${icon}
                  alt=""
                  aria-hidden="true"
                  width="14"
                  height="14"
                  class="brightness-0 invert opacity-80"
                />`
              : ""}
            <span>${name}</span>
          </div>
          ${unit.hasHealth() ? this.renderHealthBar(unit) : ""}
          ${unit.type() === UnitType.TransportShip
            ? html`
                <div class="text-sm mt-1">
                  Troops: ${renderTroops(unit.troops())}
                </div>
              `
            : ""}
          ${unit.type() === UnitType.Fighter
            ? html`<div class="text-xs mt-1 text-blue-300">
                Auto-intercept: active
              </div>`
            : ""}
          ${isOwnBase ? this.renderAircraftCounts(unit) : ""}
        </div>
      </div>
    `;
  }

  render() {
    if (!this._isActive) {
      return html``;
    }

    const containerClasses = this._isInfoVisible
      ? "opacity-100 visible"
      : "opacity-0 invisible pointer-events-none";

    return html`
      <div
        class="fixed top-0 left-0 right-0 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-[1001]"
        style="margin-top: ${this.barOffset}px;"
        @click=${() => this.hide()}
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
      >
        <div
          class="bg-gray-800/92 backdrop-blur-sm shadow-xs min-[1200px]:rounded-lg sm:rounded-b-lg shadow-lg text-white text-lg lg:text-base w-full sm:w-[500px] overflow-hidden ${containerClasses}"
        >
          ${this.player !== null ? this.renderPlayerInfo(this.player) : ""}
          ${this.unit !== null ? this.renderUnitInfo(this.unit) : ""}
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this; // Disable shadow DOM to allow Tailwind styles
  }
}
