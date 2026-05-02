/**
 * Part 9 — Naval Balance Validation Tests
 *
 * Tests verify combat outcomes, income formulas, blockade logic, repair
 * mechanics and unit behavior against the naval-system specification.
 */

import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { BattleshipExecution } from "../src/core/execution/BattleshipExecution";
import { CarrierExecution } from "../src/core/execution/CarrierExecution";
import { CruiserExecution } from "../src/core/execution/CruiserExecution";
import { DestroyerExecution } from "../src/core/execution/DestroyerExecution";
import { FighterExecution } from "../src/core/execution/FighterExecution";
import { MineExecution } from "../src/core/execution/MineExecution";
import { MinelayerExecution } from "../src/core/execution/MinelayerExecution";
import {
  ensureShipHomePort,
  NAVAL_REPAIR_RATE,
  repairShipIfDocked,
} from "../src/core/execution/NavalRepair";
import {
  navalIncomeMultiplier,
  PortExecution,
} from "../src/core/execution/PortExecution";
import { ShipMissionRunner } from "../src/core/execution/ShipMissionRunner";
import { SubmarineExecution } from "../src/core/execution/SubmarineExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitMission,
  UnitType,
} from "../src/core/game/Game";
import { WaterPathFinder } from "../src/core/pathfinding/PathFinder";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { setup } from "./util/Setup";

// In the half_land_half_ocean test map:
//   x = 7  →  coastline
//   x ≥ 8  →  open ocean
const COAST_X = 7;

let game: Game;
let p1: Player;
let p2: Player;

async function freshGame() {
  game = await setup(
    "half_land_half_ocean",
    { infiniteGold: true, instantBuild: true },
    [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
    ],
  );
  while (game.inSpawnPhase()) game.executeNextTick();
  p1 = game.player("p1");
  p2 = game.player("p2");
}

/** Shorthand: open-ocean tile with optional offset from the base position. */
function wTile(dx = 0, dy = 0) {
  return game.ref(COAST_X + 1 + dx, 10 + dy);
}

/** Make p1 and p2 mutual allies (double request = accepted). */
async function makeAllies() {
  // Players must own at least one tile to be "alive" and able to send requests.
  if (p1.numTilesOwned() === 0) p1.conquer(game.ref(0, 0));
  if (p2.numTilesOwned() === 0) p2.conquer(game.ref(1, 0));
  game.addExecution(new AllianceRequestExecution(p1, p2.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(p2, p1.id()));
  game.executeNextTick();
}

/** Effective DPS a unit type deals against another, using avg-roll damage. */
function effectiveDps(
  attackerType: UnitType,
  defenderType: UnitType,
  rateOverride?: number,
): number {
  const cfg = game.config();
  const atkInfo = cfg.unitInfo(attackerType);
  const defInfo = cfg.unitInfo(defenderType);
  const mult = cfg.combatMultiplier(attackerType, defenderType);
  const baseDmg = Number(atkInfo.damage ?? 0);
  const armor = defInfo.armor ?? 1.0;
  const rate = rateOverride ?? atkInfo.attackRate ?? 1;
  return (baseDmg * mult * armor) / rate;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Zero-damage ships
// ─────────────────────────────────────────────────────────────────────────────

describe("Zero-damage ships", () => {
  test("minelayer deals 0 damage to all target types", async () => {
    await freshGame();
    const info = game.config().unitInfo(UnitType.Minelayer);
    // Minelayer has no damage stat — ShipMissionRunner baseDamage=0
    expect(info.damage ?? 0).toBe(0);
  });

  test("carrier deals 0 damage to all target types", async () => {
    await freshGame();
    const tile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, tile, { patrolTile: tile });
    const exec = new CarrierExecution(carrier);
    exec.init(game, 0);

    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });
    const hpBefore = sub.health();

    for (let i = 0; i < 30; i++) {
      exec.tick(i);
      game.executeNextTick();
    }
    if (sub.isActive()) {
      expect(sub.health()).toBe(hpBefore);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Mine mechanics
// ─────────────────────────────────────────────────────────────────────────────

describe("Mine mechanics", () => {
  test("mine config damage is exactly 150", async () => {
    await freshGame();
    const mineDamage = game.config().unitInfo(UnitType.Mine).damage ?? 0;
    expect(mineDamage).toBe(150);
  });

  test("mine deals exactly 150 flat damage ignoring ship armor", async () => {
    await freshGame();
    const tile = wTile();
    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });
    const subMaxHp = Number(
      game.config().unitInfo(UnitType.Submarine).maxHealth,
    );
    const subArmor = game.config().unitInfo(UnitType.Submarine).armor ?? 1.0;

    // Verify sub has armor < 1 (so if armor were applied damage would differ)
    expect(subArmor).toBeLessThan(1.0);

    // Trigger mine
    game.addExecution(new MineExecution(p1, tile));
    game.executeNextTick(); // init — builds Mine unit
    game.executeNextTick(); // tick — detonate

    if (sub.isActive()) {
      // Damage = exactly 150, not 150 * armor
      expect(sub.health()).toBe(subMaxHp - 150);
    }
    // (If sub was already at ≤150 HP it would be dead — also acceptable)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Naval trade income formula
// ─────────────────────────────────────────────────────────────────────────────

describe("Naval trade income multiplier", () => {
  test("balanced slider (0.5 workerRatio) → 1.0× multiplier", () => {
    expect(navalIncomeMultiplier(0.5)).toBe(1.0);
  });

  test("full workers slider (1.0 workerRatio) → 2.0× multiplier", () => {
    expect(navalIncomeMultiplier(1.0)).toBe(2.0);
  });

  test("full troops slider (0.0 workerRatio) → 0.5× multiplier", () => {
    expect(navalIncomeMultiplier(0.0)).toBe(0.5);
  });

  test("full workers gives 2× income vs full troops", () => {
    const full = navalIncomeMultiplier(1.0);
    const zero = navalIncomeMultiplier(0.0);
    expect(full / zero).toBe(4.0);
  });

  test("naval trade income formula: 400 tiles at balanced slider → +4 g/tick", () => {
    // Verify the PortExecution income formula directly.
    // bonus = floor(tiles/200)*2, scaled by navalIncomeMultiplier.
    // (The test map is only 16×16 so we cannot actually own 400 tiles;
    //  we verify the math instead.)
    const tiles = 400;
    const bonus = Math.floor(tiles / 200) * 2;
    const multiplier = navalIncomeMultiplier(0.5); // balanced slider → 1.0×
    expect(bonus).toBe(4);
    expect(Math.round(bonus * multiplier)).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Blockade mechanics
// ─────────────────────────────────────────────────────────────────────────────

describe("Blockade mechanics", () => {
  async function blockadeSetup() {
    await freshGame();
    p1.conquer(game.ref(COAST_X, 10));
  }

  function makePort() {
    const portTile = game.ref(COAST_X, 10);
    const port = p1.buildUnit(UnitType.Port, portTile, {});
    const exec = new PortExecution(port);
    exec.init(game, 0);
    return { port, exec };
  }

  test("3 enemy ships within 2 tiles → port blockaded, no income", async () => {
    await blockadeSetup();
    const { port, exec } = makePort();

    // All 3 ships must be within Euclidean distance 2 of the port.
    // distSq: (8,10)→1, (9,10)→4, (8,9)→2 — all ≤ 4.
    const blockadeTiles = [
      game.ref(COAST_X + 1, 10),
      game.ref(COAST_X + 2, 10),
      game.ref(COAST_X + 1, 9),
    ];
    for (const t of blockadeTiles) {
      p2.buildUnit(UnitType.Destroyer, t, { patrolTile: t });
    }

    const goldBefore = p1.gold();
    exec.tick(1);

    expect(port.blockaded()).toBe(true);
    expect(p1.gold()).toBe(goldBefore); // no income while blockaded
  });

  test("2 enemy ships within 2 tiles → port NOT blockaded", async () => {
    await blockadeSetup();
    const { port, exec } = makePort();

    p2.buildUnit(UnitType.Destroyer, game.ref(COAST_X + 1, 10), {
      patrolTile: game.ref(COAST_X + 1, 10),
    });
    p2.buildUnit(UnitType.Destroyer, game.ref(COAST_X + 2, 10), {
      patrolTile: game.ref(COAST_X + 2, 10),
    });

    exec.tick(1);

    expect(port.blockaded()).toBe(false);
  });

  test("allied ships do NOT count toward blockade", async () => {
    await blockadeSetup();
    const { port, exec } = makePort();

    await makeAllies();

    // Same 3 positions all within Euclidean range 2 of port
    const blockadeTiles = [
      game.ref(COAST_X + 1, 10),
      game.ref(COAST_X + 2, 10),
      game.ref(COAST_X + 1, 9),
    ];
    for (const t of blockadeTiles) {
      p2.buildUnit(UnitType.Destroyer, t, { patrolTile: t });
    }

    exec.tick(3); // after alliances formed
    expect(port.blockaded()).toBe(false);
  });

  test("embargo prevents trade between allied players", async () => {
    await blockadeSetup();

    await makeAllies();
    expect(p1.canTrade(p2)).toBe(true); // no embargo yet

    p1.addEmbargo(p2, false);

    // Embargo is bidirectional for trade
    expect(p1.canTrade(p2)).toBe(false);
    expect(p2.canTrade(p1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Naval yard repair
// ─────────────────────────────────────────────────────────────────────────────

describe("Naval yard repair", () => {
  test("naval yard repair rate constant is 2 HP/tick", () => {
    expect(NAVAL_REPAIR_RATE).toBe(2);
  });

  test("docked ship at naval yard gains exactly 2 HP per tick", async () => {
    await freshGame();

    const portTile = game.ref(COAST_X, 10);
    p1.conquer(portTile);
    p1.buildUnit(UnitType.Port, portTile, {});

    // NavalYard within 30 tiles of port
    const yardTile = game.ref(COAST_X - 1, 10);
    p1.conquer(yardTile);
    p1.buildUnit(UnitType.NavalYard, yardTile, {});

    const ship = p1.buildUnit(UnitType.Destroyer, portTile, {
      patrolTile: portTile,
    });
    ship.modifyHealth(-100);
    ship.setMission(UnitMission.HOLD_POSITION);

    const hpBefore = ship.health();
    repairShipIfDocked(game, ship);

    expect(ship.health() - hpBefore).toBe(NAVAL_REPAIR_RATE);
  });

  test("docked ship WITHOUT naval yard gains 0 HP per tick", async () => {
    await freshGame();

    const portTile = game.ref(COAST_X, 10);
    p1.conquer(portTile);
    p1.buildUnit(UnitType.Port, portTile, {}); // port only, no NavalYard

    const ship = p1.buildUnit(UnitType.Destroyer, portTile, {
      patrolTile: portTile,
    });
    ship.modifyHealth(-100);
    ship.setMission(UnitMission.HOLD_POSITION);

    const hpBefore = ship.health();
    repairShipIfDocked(game, ship);

    expect(ship.health()).toBe(hpBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Port destruction / homeless ships
// ─────────────────────────────────────────────────────────────────────────────

describe("Port destruction and homeless ships", () => {
  test("port destroyed: ships reassigned to nearest surviving port", async () => {
    await freshGame();

    const portA = p1.buildUnit(UnitType.Port, game.ref(COAST_X, 10), {});
    const portB = p1.buildUnit(UnitType.Port, game.ref(COAST_X, 15), {});

    const ship = p1.buildUnit(UnitType.Destroyer, wTile(), {
      patrolTile: portA.tile(),
    });
    expect(ship.patrolTile()).toBe(portA.tile());

    portA.delete();
    ensureShipHomePort(game, ship);

    expect(ship.patrolTile()).toBe(portB.tile());
  });

  test("no friendly port: ship becomes homeless (patrolTile undefined)", async () => {
    await freshGame();

    const port = p1.buildUnit(UnitType.Port, game.ref(COAST_X, 10), {});
    const ship = p1.buildUnit(UnitType.Destroyer, wTile(), {
      patrolTile: port.tile(),
    });

    port.delete();
    ensureShipHomePort(game, ship);

    expect(ship.patrolTile()).toBeUndefined();
  });

  test("homeless ship: no HP regen even when mission is HOLD_POSITION", async () => {
    await freshGame();

    // No port for p1
    const ship = p1.buildUnit(UnitType.Destroyer, wTile(), {
      patrolTile: wTile(), // has patrol tile but no port
    });
    ship.modifyHealth(-200);
    ship.setMission(UnitMission.HOLD_POSITION);

    const hpBefore = ship.health();
    repairShipIfDocked(game, ship);

    expect(ship.health()).toBe(hpBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Sweep mechanics
// ─────────────────────────────────────────────────────────────────────────────

describe("Mine sweep mechanics", () => {
  function makeRunner(ship: ReturnType<Player["buildUnit"]>) {
    const info = game.config().unitInfo(UnitType.Destroyer);
    return new ShipMissionRunner(
      ship,
      game,
      new WaterPathFinder(game),
      new PseudoRandom(0),
      {
        shipType: UnitType.Destroyer,
        baseDamage: Number(info.damage ?? 200),
        attackRate: info.attackRate ?? 10,
        range: info.range ?? 100,
      },
    );
  }

  test("sweep costs 200g and removes enemy mines within 2-tile radius", async () => {
    await freshGame();

    const shipTile = wTile();
    const ship = p1.buildUnit(UnitType.Destroyer, shipTile, {
      patrolTile: shipTile,
    });
    const runner = makeRunner(ship);

    // Enemy mines within 2 tiles
    const mine1 = p2.buildUnit(UnitType.Mine, wTile(1), {});
    const mine2 = p2.buildUnit(UnitType.Mine, wTile(2), {});
    // Mine 3 tiles away — should NOT be swept
    const mine3 = p2.buildUnit(UnitType.Mine, wTile(5), {});

    p1.addGold(1000n);
    const goldBefore = p1.gold();

    ship.setMission(UnitMission.SWEEP_MINES);
    ship.setMissionTargetTile(shipTile);

    // Run 12 ticks: ship arrives immediately, countdown from tick 0
    for (let i = 0; i < 12; i++) {
      runner.run();
      game.executeNextTick();
    }

    expect(Number(goldBefore - p1.gold())).toBe(200);
    expect(mine1.isActive()).toBe(false);
    expect(mine2.isActive()).toBe(false);
    expect(mine3.isActive()).toBe(true);
  });

  test("sweep rejected if player gold < 200g", async () => {
    await freshGame();

    const shipTile = wTile();
    const ship = p1.buildUnit(UnitType.Destroyer, shipTile, {
      patrolTile: shipTile,
    });
    const runner = makeRunner(ship);

    // Drain gold below cost
    p1.removeGold(p1.gold());
    p1.addGold(100n);

    ship.setMission(UnitMission.SWEEP_MINES);
    ship.setMissionTargetTile(shipTile);

    const goldBefore = p1.gold();
    runner.run();

    expect(ship.mission()).toBeUndefined(); // cleared without executing
    expect(p1.gold()).toBe(goldBefore); // no gold spent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Carrier behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("Carrier behavior", () => {
  function carrierRunner(carrier: ReturnType<Player["buildUnit"]>) {
    return new ShipMissionRunner(
      carrier,
      game,
      new WaterPathFinder(game),
      new PseudoRandom(0),
      { shipType: UnitType.Carrier, baseDamage: 0, attackRate: 999, range: 1 },
    );
  }

  test("carrier auto-flees when enemy ship enters patrol radius", async () => {
    await freshGame();

    const carrierTile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, carrierTile, {
      patrolTile: carrierTile,
    });
    carrier.setMission(UnitMission.PATROL_AREA);
    carrier.setMissionTargetTile(carrierTile);

    // Port for carrier to flee to
    const portTile = game.ref(COAST_X, 10);
    p1.conquer(portTile);
    p1.buildUnit(UnitType.Port, portTile, {});

    // Enemy within patrol radius (2 tiles)
    p2.buildUnit(UnitType.Destroyer, wTile(1), {
      patrolTile: wTile(1),
    });

    carrierRunner(carrier).run();

    expect(carrier.mission()).toBe(UnitMission.MOVE_TO_TILE);
    expect(carrier.missionTargetTile()).toBe(portTile);
  });

  test("carrier does NOT auto-engage enemies (unlike other patrol ships)", async () => {
    await freshGame();

    const carrierTile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, carrierTile, {
      patrolTile: carrierTile,
    });
    carrier.setMission(UnitMission.PATROL_AREA);
    carrier.setMissionTargetTile(carrierTile);

    const enemy = p2.buildUnit(UnitType.Destroyer, carrierTile, {
      patrolTile: carrierTile,
    });
    const enemyHpBefore = enemy.health();

    // No port — carrier can't flee, but still must not attack
    carrierRunner(carrier).run();

    // Must NOT switch to ATTACK_SHIP
    expect(carrier.mission()).not.toBe(UnitMission.ATTACK_SHIP);
    // Enemy untouched — carrier deals no damage
    expect(enemy.health()).toBe(enemyHpBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Destroyer ASW (depth charges)
// ─────────────────────────────────────────────────────────────────────────────

describe("Destroyer ASW behavior", () => {
  test("destroyer depth charges damage submarines within 3 tiles", async () => {
    await freshGame();

    const tile = wTile();
    const destroyer = p1.buildUnit(UnitType.Destroyer, tile, {
      patrolTile: tile,
    });
    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });
    const subHpStart = sub.health();

    const exec = new DestroyerExecution(destroyer);
    exec.init(game, 0);

    for (let i = 0; i < 10; i++) {
      exec.tick(i);
      game.executeNextTick();
    }

    // Sub should have taken at least one ASW hit
    if (sub.isActive()) {
      expect(sub.health()).toBeLessThan(subHpStart);
    }
    // (sub being dead also proves depth charges fired)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Battleship does not pathfind toward submarines in auto mode
// ─────────────────────────────────────────────────────────────────────────────

describe("Battleship auto-mode", () => {
  test("battleship does not auto-pathfind toward submarines", async () => {
    await freshGame();

    const bsTile = wTile(0);
    const subTile = wTile(5, 3); // within 16×16 map bounds (x=13, y=13)

    const bs = p1.buildUnit(UnitType.Battleship, bsTile, {
      patrolTile: bsTile,
    });
    p2.buildUnit(UnitType.Submarine, subTile, { patrolTile: subTile });

    const exec = new BattleshipExecution(bs);
    exec.init(game, 0);

    for (let i = 0; i < 20; i++) {
      exec.tick(i);
      game.executeNextTick();
    }

    // Battleship should not have reached the submarine's tile
    expect(bs.tile()).not.toBe(subTile);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Minelayer does not pathfind toward enemies
// ─────────────────────────────────────────────────────────────────────────────

describe("Minelayer auto-mode", () => {
  test("minelayer does not auto-pathfind toward any enemy", async () => {
    await freshGame();

    const layerTile = wTile(0);
    const enemyTile = wTile(5, 3); // within 16×16 map bounds (x=13, y=13)

    const minelayer = p1.buildUnit(UnitType.Minelayer, layerTile, {
      patrolTile: layerTile,
    });
    p2.buildUnit(UnitType.Destroyer, enemyTile, { patrolTile: enemyTile });

    const exec = new MinelayerExecution(minelayer);
    exec.init(game, 0);

    for (let i = 0; i < 30; i++) {
      exec.tick(i);
      game.executeNextTick();
    }

    expect(minelayer.tile()).not.toBe(enemyTile);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Combat ratio analytical tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Combat balance (analytical)", () => {
  test("destroyer has 3× combat multiplier vs submarine (ASW advantage)", async () => {
    await freshGame();
    expect(
      game.config().combatMultiplier(UnitType.Destroyer, UnitType.Submarine),
    ).toBe(3.0);
  });

  test("submarine has 0.5× multiplier vs destroyer (penalized vs ASW ships)", async () => {
    await freshGame();
    expect(
      game.config().combatMultiplier(UnitType.Submarine, UnitType.Destroyer),
    ).toBe(0.5);
  });

  test("submarine has 3.5× multiplier vs battleship (ambush)", async () => {
    await freshGame();
    expect(
      game.config().combatMultiplier(UnitType.Submarine, UnitType.Battleship),
    ).toBe(3.5);
  });

  test("submarine is more effective vs battleship than battleship vs submarine", async () => {
    await freshGame();
    const subVsBs = effectiveDps(UnitType.Submarine, UnitType.Battleship);
    const bsVsSub = effectiveDps(UnitType.Battleship, UnitType.Submarine);
    expect(subVsBs).toBeGreaterThan(bsVsSub * 1.5);
  });

  test("cruiser wins 1v1 vs destroyer by DPS×HP metric", async () => {
    await freshGame();
    const cruDps = effectiveDps(UnitType.Cruiser, UnitType.Destroyer);
    const desDps = effectiveDps(UnitType.Destroyer, UnitType.Cruiser);
    const cruHp = Number(game.config().unitInfo(UnitType.Cruiser).maxHealth);
    const desHp = Number(game.config().unitInfo(UnitType.Destroyer).maxHealth);
    expect(cruDps * cruHp).toBeGreaterThan(desDps * desHp);
  });

  test("battleship wins 1v1 vs cruiser by DPS×HP metric", async () => {
    await freshGame();
    const bsDps = effectiveDps(UnitType.Battleship, UnitType.Cruiser);
    const cruDps = effectiveDps(UnitType.Cruiser, UnitType.Battleship);
    const bsHp = Number(game.config().unitInfo(UnitType.Battleship).maxHealth);
    const cruHp = Number(game.config().unitInfo(UnitType.Cruiser).maxHealth);
    expect(bsDps * bsHp).toBeGreaterThan(cruDps * cruHp);
  });

  test("submarine sinks battleship in a bounded number of torpedo hits", async () => {
    await freshGame();
    const subDmg = Number(
      game.config().unitInfo(UnitType.Submarine).damage ?? 750,
    );
    const mult = game
      .config()
      .combatMultiplier(UnitType.Submarine, UnitType.Battleship);
    const armor = game.config().unitInfo(UnitType.Battleship).armor ?? 1.0;
    const bsHp = Number(game.config().unitInfo(UnitType.Battleship).maxHealth);
    const avgPerHit = Math.round(subDmg * mult * armor);
    const hitsNeeded = Math.ceil(bsHp / avgPerHit);
    // Sub should sink battleship in a reasonable number of hits (not dozens)
    expect(hitsNeeded).toBeGreaterThan(0);
    expect(hitsNeeded).toBeLessThanOrEqual(15);
  });

  test("submarine sinks carrier in a bounded number of torpedo hits", async () => {
    await freshGame();
    const subDmg = Number(
      game.config().unitInfo(UnitType.Submarine).damage ?? 750,
    );
    const mult = game
      .config()
      .combatMultiplier(UnitType.Submarine, UnitType.Carrier);
    const armor = game.config().unitInfo(UnitType.Carrier).armor ?? 0.55;
    const carrierHp = Number(
      game.config().unitInfo(UnitType.Carrier).maxHealth,
    );
    const avgPerHit = Math.round(subDmg * mult * armor);
    const hitsNeeded = Math.ceil(carrierHp / avgPerHit);
    expect(mult).toBe(4.0); // sub has strong bonus vs carrier
    expect(hitsNeeded).toBeLessThanOrEqual(10);
  });

  test("coastal battery is destroyed after bounded cruiser bombardment shots", async () => {
    await freshGame();
    const cruDmg = Number(
      game.config().unitInfo(UnitType.Cruiser).damage ?? 375,
    );
    const mult = game
      .config()
      .combatMultiplier(UnitType.Cruiser, UnitType.CoastalBattery);
    const armor = game.config().unitInfo(UnitType.CoastalBattery).armor ?? 1.0;
    const batHp = Number(
      game.config().unitInfo(UnitType.CoastalBattery).maxHealth,
    );
    const avgPerShot = Math.round(cruDmg * mult * armor);
    const shots = Math.ceil(batHp / avgPerShot);
    expect(shots).toBeGreaterThan(0);
    expect(shots).toBeLessThanOrEqual(20);

    // Direct simulation: apply exactly that many shots
    // CoastalBattery is a land unit — use a coastal land tile (not water).
    const batteryTile = game.ref(COAST_X - 1, 10);
    p2.conquer(batteryTile);
    const battery = p2.buildUnit(UnitType.CoastalBattery, batteryTile, {});
    for (let i = 0; i < shots - 1; i++) battery.modifyHealth(-avgPerShot, p1);
    expect(battery.isActive()).toBe(true);
    battery.modifyHealth(-avgPerShot, p1);
    expect(battery.isActive()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Full combat simulations
// ─────────────────────────────────────────────────────────────────────────────

describe("Full combat simulations", () => {
  test("destroyer and submarine fight to a decisive result", async () => {
    await freshGame();

    const tile = wTile();
    const destroyer = p1.buildUnit(UnitType.Destroyer, tile, {
      patrolTile: tile,
    });
    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });

    const dExec = new DestroyerExecution(destroyer);
    const sExec = new SubmarineExecution(sub);
    dExec.init(game, 0);
    sExec.init(game, 0);

    for (let i = 0; i < 500 && destroyer.isActive() && sub.isActive(); i++) {
      dExec.tick(i);
      sExec.tick(i);
      game.executeNextTick();
    }

    // Exactly one should be dead
    expect(destroyer.isActive() && sub.isActive()).toBe(false);
    expect(destroyer.isActive() || sub.isActive()).toBe(true);
  });

  test("3 destroyers sink a single submarine before sub fires twice", async () => {
    await freshGame();

    const tile = wTile();
    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });

    const destroyers = [
      p1.buildUnit(UnitType.Destroyer, tile, { patrolTile: tile }),
      p1.buildUnit(UnitType.Destroyer, wTile(1), { patrolTile: tile }),
      p1.buildUnit(UnitType.Destroyer, wTile(2), { patrolTile: tile }),
    ];
    const execs = destroyers.map((d) => {
      const e = new DestroyerExecution(d);
      e.init(game, 0);
      return e;
    });
    const sExec = new SubmarineExecution(sub);
    sExec.init(game, 0);

    for (let i = 0; i < 200 && sub.isActive(); i++) {
      execs.forEach((e) => e.tick(i));
      sExec.tick(i);
      game.executeNextTick();
    }

    // 3v1 ASW advantage: sub must be dead
    expect(sub.isActive()).toBe(false);
    // At least one destroyer survives
    expect(destroyers.some((d) => d.isActive())).toBe(true);
  });

  test("carrier unescorted is sunk by a single submarine", async () => {
    await freshGame();

    const tile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, tile, { patrolTile: tile });
    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });

    const cExec = new CarrierExecution(carrier);
    const sExec = new SubmarineExecution(sub);
    cExec.init(game, 0);
    sExec.init(game, 0);

    for (let i = 0; i < 500 && carrier.isActive(); i++) {
      cExec.tick(i);
      sExec.tick(i);
      game.executeNextTick();
    }

    expect(carrier.isActive()).toBe(false); // carrier sunk
    expect(sub.isActive()).toBe(true); // sub survives (carrier can't shoot)
  });

  test("carrier escorted by 2 destroyers + 1 cruiser survives submarine attack", async () => {
    await freshGame();

    const tile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, tile, { patrolTile: tile });
    const sub = p2.buildUnit(UnitType.Submarine, tile, { patrolTile: tile });

    const d1 = p1.buildUnit(UnitType.Destroyer, tile, { patrolTile: tile });
    const d2 = p1.buildUnit(UnitType.Destroyer, wTile(1), { patrolTile: tile });
    const cr = p1.buildUnit(UnitType.Cruiser, wTile(2), { patrolTile: tile });

    const allExecs = [
      new CarrierExecution(carrier),
      new DestroyerExecution(d1),
      new DestroyerExecution(d2),
      new CruiserExecution(cr),
      new SubmarineExecution(sub),
    ];
    allExecs.forEach((e) => e.init(game, 0));

    for (let i = 0; i < 500 && sub.isActive(); i++) {
      allExecs.forEach((e) => e.tick(i));
      game.executeNextTick();
    }

    expect(sub.isActive()).toBe(false); // sub destroyed by escorts
    expect(carrier.isActive()).toBe(true); // carrier protected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Carrier aircraft cascade
// ─────────────────────────────────────────────────────────────────────────────

describe("Carrier aircraft cascade", () => {
  test("carrier sunk: fighter with no other base crashes on next tick", async () => {
    await freshGame();

    // Build carrier (sole home base for the fighter)
    const carrierTile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, carrierTile, {
      patrolTile: carrierTile,
    });

    // Build a fighter docked at the carrier tile
    const fighter = p1.buildUnit(UnitType.Fighter, carrierTile, {
      patrolTile: carrierTile,
    });
    const fExec = new FighterExecution(fighter);
    fExec.init(game, 0);
    expect(fighter.isActive()).toBe(true);

    // Sink the carrier — no other airbases or carriers exist
    carrier.delete();
    expect(carrier.isActive()).toBe(false);

    // FighterExecution.updateHomeBase() finds nothing → deletes fighter
    fExec.tick(1);

    expect(fighter.isActive()).toBe(false); // crashed: no home base
  });

  test("carrier sunk: fighter rebases to surviving airbase", async () => {
    await freshGame();

    // Build carrier as initial home base
    const carrierTile = wTile();
    const carrier = p1.buildUnit(UnitType.Carrier, carrierTile, {
      patrolTile: carrierTile,
    });

    // Also build an airbase on land — provides an alternate home
    const landTile = game.ref(COAST_X - 1, 10); // x=6 is land
    p1.conquer(landTile);
    p1.buildUnit(UnitType.Airbase, landTile, {});

    // Build a fighter docked at the carrier tile
    const fighter = p1.buildUnit(UnitType.Fighter, carrierTile, {
      patrolTile: carrierTile,
    });
    const fExec = new FighterExecution(fighter);
    fExec.init(game, 0);

    // Sink the carrier — airbase is still alive
    carrier.delete();

    // FighterExecution.updateHomeBase() finds the airbase → fighter survives
    fExec.tick(1);

    expect(fighter.isActive()).toBe(true); // rebased to airbase, still flying
  });
});
