import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import {
  BuildableUnit,
  BuildMenus,
  Gold,
  PlayerBuildableUnitType,
  UnitType,
} from "../../../core/game/Game";
import { GameView } from "../../../core/game/GameView";
import { UserSettings } from "../../../core/game/UserSettings";
import {
  GhostStructureChangedEvent,
  ToggleStructureEvent,
} from "../../InputHandler";
import { renderNumber, translateText } from "../../Utils";
import { UIState } from "../UIState";
import { Layer } from "./Layer";
const cityIcon = assetUrl("images/CityIconWhite.svg");
const factoryIcon = assetUrl("images/FactoryIconWhite.svg");
const goldCoinIcon = assetUrl("images/GoldCoinIcon.svg");
const mirvIcon = assetUrl("images/MIRVIcon.svg");
const missileSiloIcon = assetUrl("images/MissileSiloIconWhite.svg");
const hydrogenBombIcon = assetUrl("images/MushroomCloudIconWhite.svg");
const atomBombIcon = assetUrl("images/NukeIconWhite.svg");
const portIcon = assetUrl("images/PortIcon.svg");
const samLauncherIcon = assetUrl("images/SamLauncherIconWhite.svg");
const defensePostIcon = assetUrl("images/ShieldIconWhite.svg");
const navalYardIcon = assetUrl("images/NavalYardIconWhite.svg");
const airbaseIcon = assetUrl("images/AirbaseIconWhite.svg");
const coastalBatteryIcon = assetUrl("images/CoastalBatteryIconWhite.svg");

@customElement("unit-display")
export class UnitDisplay extends LitElement implements Layer {
  public game: GameView;
  public eventBus: EventBus;
  public uiState: UIState;
  private playerBuildables: BuildableUnit[] | null = null;
  private keybinds: Record<string, { value: string; key: string }> = {};
  private _cities = 0;
  private _factories = 0;
  private _missileSilo = 0;
  private _port = 0;
  private _defensePost = 0;
  private _samLauncher = 0;
  private _navalYard = 0;
  private _airbase = 0;
  private _coastalBattery = 0;
  private allDisabled = false;
  private _hoveredUnit: PlayerBuildableUnitType | null = null;
  private _hoverPos: { x: number; y: number } | null = null;
  private _hoverStructureKey = "";
  private _hoverDisplayHotkey = "";

  createRenderRoot() {
    return this;
  }

  init() {
    const config = this.game.config();
    const userSettings = new UserSettings();

    this.keybinds = userSettings.parsedUserKeybinds();

    this.allDisabled = BuildMenus.types.every((u) => config.isUnitDisabled(u));
    this.requestUpdate();
  }

  private cost(item: UnitType): Gold {
    for (const bu of this.playerBuildables ?? []) {
      if (bu.type === item) {
        return bu.cost;
      }
    }
    return 0n;
  }

  private canBuild(item: UnitType): boolean {
    if (this.game?.config().isUnitDisabled(item)) return false;
    const player = this.game?.myPlayer();
    switch (item) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.MIRV:
        return (
          this.cost(item) <= (player?.gold() ?? 0n) &&
          (player?.units(UnitType.MissileSilo).length ?? 0) > 0
        );
      case UnitType.Destroyer:
      case UnitType.Minelayer:
        return (
          this.cost(item) <= (player?.gold() ?? 0n) &&
          (player?.units(UnitType.Port).length ?? 0) > 0
        );
      case UnitType.Cruiser:
      case UnitType.Battleship:
      case UnitType.Submarine:
      case UnitType.Carrier:
        return (
          this.cost(item) <= (player?.gold() ?? 0n) &&
          (player?.units(UnitType.Port).length ?? 0) > 0 &&
          (player?.units(UnitType.NavalYard).length ?? 0) > 0
        );
      case UnitType.NavalYard:
      case UnitType.CoastalBattery:
        return (
          this.cost(item) <= (player?.gold() ?? 0n) &&
          (player?.units(UnitType.Port).length ?? 0) > 0
        );
      case UnitType.Fighter:
      case UnitType.Bomber:
        return (
          this.cost(item) <= (player?.gold() ?? 0n) &&
          (player?.units(UnitType.Airbase).length ?? 0) > 0
        );
      case UnitType.AttackHelicopter:
        return (
          this.cost(item) <= (player?.gold() ?? 0n) &&
          (player?.units(UnitType.Airbase).length ?? 0) > 0
        );
      default:
        return this.cost(item) <= (player?.gold() ?? 0n);
    }
  }

  tick() {
    const player = this.game?.myPlayer();
    if (!player) return;
    player.buildables(undefined, BuildMenus.types).then((buildables) => {
      this.playerBuildables = buildables;
    });
    this._cities = player.totalUnitLevels(UnitType.City);
    this._missileSilo = player.totalUnitLevels(UnitType.MissileSilo);
    this._port = player.totalUnitLevels(UnitType.Port);
    this._defensePost = player.totalUnitLevels(UnitType.DefensePost);
    this._samLauncher = player.totalUnitLevels(UnitType.SAMLauncher);
    this._factories = player.totalUnitLevels(UnitType.Factory);
    this._navalYard = player.totalUnitLevels(UnitType.NavalYard);
    this._airbase = player.totalUnitLevels(UnitType.Airbase);
    this._coastalBattery = player.totalUnitLevels(UnitType.CoastalBattery);
    this.requestUpdate();
  }

  render() {
    const myPlayer = this.game?.myPlayer();
    if (
      !this.game ||
      !myPlayer ||
      this.game.inSpawnPhase() ||
      !myPlayer.isAlive()
    ) {
      return null;
    }
    if (this.allDisabled) {
      return null;
    }

    const hovered = this._hoveredUnit;
    const hoverPos = this._hoverPos;
    return html`
      ${hovered && hoverPos
        ? html`<div
            class="fixed z-[200] pointer-events-none text-gray-200 text-center w-max text-xs bg-gray-800/90 backdrop-blur-xs rounded-sm p-2 shadow-lg"
            style="left:${hoverPos.x}px;top:${hoverPos.y}px;transform:translate(-50%,-100%) translateY(-8px)"
          >
            <div class="font-bold text-sm mb-1">
              ${translateText(
                "unit_type." + this._hoverStructureKey,
              )}${` [${this._hoverDisplayHotkey}]`}
            </div>
            <div class="px-2 pb-1 text-gray-300">
              ${translateText("build_menu.desc." + this._hoverStructureKey)}
            </div>
            <div class="flex items-center justify-center gap-1">
              <img src=${goldCoinIcon} width="13" height="13" />
              <span class="text-yellow-300"
                >${renderNumber(this.cost(hovered))}</span
              >
            </div>
          </div>`
        : null}
      <div class="border-t border-white/10 w-full">
        <div class="flex flex-nowrap justify-center gap-2 px-3 py-1.5 overflow-x-auto">
          ${this.renderUnitItem(
            cityIcon,
            this._cities,
            UnitType.City,
            "city",
            this.keybinds["buildCity"]?.key ?? "1",
          )}
          ${this.renderUnitItem(
            factoryIcon,
            this._factories,
            UnitType.Factory,
            "factory",
            this.keybinds["buildFactory"]?.key ?? "2",
          )}
          ${this.renderUnitItem(
            portIcon,
            this._port,
            UnitType.Port,
            "port",
            this.keybinds["buildPort"]?.key ?? "3",
          )}
          ${this.renderUnitItem(
            defensePostIcon,
            this._defensePost,
            UnitType.DefensePost,
            "defense_post",
            this.keybinds["buildDefensePost"]?.key ?? "4",
          )}
          ${this.renderUnitItem(
            missileSiloIcon,
            this._missileSilo,
            UnitType.MissileSilo,
            "missile_silo",
            this.keybinds["buildMissileSilo"]?.key ?? "5",
          )}
          ${this.renderUnitItem(
            samLauncherIcon,
            this._samLauncher,
            UnitType.SAMLauncher,
            "sam_launcher",
            this.keybinds["buildSamLauncher"]?.key ?? "6",
          )}
          ${this.renderUnitItem(
            navalYardIcon,
            this._navalYard,
            UnitType.NavalYard,
            "naval_yard",
            this.keybinds["buildNavalYard"]?.key ?? "N",
          )}
          ${this.renderUnitItem(
            airbaseIcon,
            this._airbase,
            UnitType.Airbase,
            "airbase",
            this.keybinds["buildAirbase"]?.key ?? "I",
          )}
          ${this.renderUnitItem(
            coastalBatteryIcon,
            this._coastalBattery,
            UnitType.CoastalBattery,
            "coastal_battery",
            this.keybinds["buildCoastalBattery"]?.key ?? "L",
          )}
          ${this.renderUnitItem(
            atomBombIcon,
            null,
            UnitType.AtomBomb,
            "atom_bomb",
            this.keybinds["buildAtomBomb"]?.key ?? "8",
          )}
          ${this.renderUnitItem(
            hydrogenBombIcon,
            null,
            UnitType.HydrogenBomb,
            "hydrogen_bomb",
            this.keybinds["buildHydrogenBomb"]?.key ?? "9",
          )}
          ${this.renderUnitItem(
            mirvIcon,
            null,
            UnitType.MIRV,
            "mirv",
            this.keybinds["buildMIRV"]?.key ?? "0",
          )}
        </div>
      </div>
    `;
  }

  private renderUnitItem(
    icon: string,
    number: number | null,
    unitType: PlayerBuildableUnitType,
    structureKey: string,
    hotkey: string,
  ) {
    if (this.game.config().isUnitDisabled(unitType)) {
      return html``;
    }
    const selected = this.uiState.ghostStructure === unitType;
    const displayHotkey = hotkey
      .replace("Digit", "")
      .replace("Key", "")
      .toUpperCase();

    return html`
      <div
        class="flex flex-col items-center relative"
        @mouseenter=${(e: MouseEvent) => {
          this._hoveredUnit = unitType;
          this._hoverStructureKey = structureKey;
          this._hoverDisplayHotkey = displayHotkey;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          this._hoverPos = { x: rect.left + rect.width / 2, y: rect.top };
          this.requestUpdate();
        }}
        @mouseleave=${() => {
          this._hoveredUnit = null;
          this._hoverPos = null;
          this.requestUpdate();
        }}
      >
        <div
          class="${this.canBuild(unitType)
            ? ""
            : "opacity-40"} border border-slate-500 rounded px-2 py-1 flex items-center gap-1 cursor-pointer
             ${selected ? "hover:bg-gray-400/10" : "hover:bg-gray-800"}
             text-white ${selected ? "bg-slate-400/20" : ""}"
          @click=${() => {
            if (selected) {
              this.uiState.ghostStructure = null;
              this.eventBus?.emit(new GhostStructureChangedEvent(null));
            } else if (this.canBuild(unitType)) {
              this.uiState.ghostStructure = unitType;
              this.eventBus?.emit(new GhostStructureChangedEvent(unitType));
            }
            this.requestUpdate();
          }}
          @mouseenter=${() => {
            switch (unitType) {
              case UnitType.AtomBomb:
              case UnitType.HydrogenBomb:
                this.eventBus?.emit(
                  new ToggleStructureEvent([
                    UnitType.MissileSilo,
                    UnitType.SAMLauncher,
                  ]),
                );
                break;
              case UnitType.Destroyer:
              case UnitType.Minelayer:
                this.eventBus?.emit(new ToggleStructureEvent([UnitType.Port]));
                break;
              case UnitType.Cruiser:
              case UnitType.Battleship:
              case UnitType.Submarine:
              case UnitType.Carrier:
                this.eventBus?.emit(
                  new ToggleStructureEvent([UnitType.Port, UnitType.NavalYard]),
                );
                break;
              case UnitType.NavalYard:
              case UnitType.CoastalBattery:
                this.eventBus?.emit(new ToggleStructureEvent([UnitType.Port]));
                break;
              case UnitType.Fighter:
              case UnitType.Bomber:
                this.eventBus?.emit(
                  new ToggleStructureEvent([UnitType.Airbase]),
                );
                break;
              case UnitType.AttackHelicopter:
                this.eventBus?.emit(
                  new ToggleStructureEvent([UnitType.Airbase]),
                );
                break;
              default:
                this.eventBus?.emit(new ToggleStructureEvent([unitType]));
            }
          }}
          @mouseleave=${() =>
            this.eventBus?.emit(new ToggleStructureEvent(null))}
        >
          <div class="flex flex-col items-center gap-0.5">
            <div class="text-[10px] text-gray-400 leading-none">
              ${displayHotkey}
            </div>
            <div class="flex items-center gap-1">
              <img src=${icon} alt=${structureKey} class="align-middle size-6" />
              ${number !== null
                ? html`<span class="text-sm font-medium"
                    >${renderNumber(number)}</span
                  >`
                : null}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
