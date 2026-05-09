import { describe, expect, it } from "vitest";
import { DefaultConfig } from "../src/core/configuration/DefaultConfig";
import { UnitType } from "../src/core/game/Game";

const config = new DefaultConfig(null as any, null as any, null as any, false);

describe("Combat multiplier table", () => {
  it("defaults to 1.0 for unrelated matchups", () => {
    expect(config.combatMultiplier(UnitType.City, UnitType.Factory)).toBe(1.0);
    expect(config.combatMultiplier(UnitType.DefensePost, UnitType.City)).toBe(
      1.0,
    );
  });

  it("gives destroyers 2x vs submarines (depth charges)", () => {
    expect(
      config.combatMultiplier(UnitType.Destroyer, UnitType.Submarine),
    ).toBe(2.0);
  });

  it("gives submarines 2x vs capital ships (ambush)", () => {
    expect(
      config.combatMultiplier(UnitType.Submarine, UnitType.Battleship),
    ).toBe(2.0);
    expect(config.combatMultiplier(UnitType.Submarine, UnitType.Carrier)).toBe(
      2.0,
    );
    expect(config.combatMultiplier(UnitType.Submarine, UnitType.Warship)).toBe(
      2.0,
    );
  });

  it("does NOT buff submarines vs destroyers (destroyers are the counter)", () => {
    expect(
      config.combatMultiplier(UnitType.Submarine, UnitType.Destroyer),
    ).toBe(1.0);
  });

  it("gives cruisers 2x vs air units (AA role)", () => {
    for (const air of [
      UnitType.Fighter,
      UnitType.Bomber,
      UnitType.AttackHelicopter,
    ]) {
      expect(config.combatMultiplier(UnitType.Cruiser, air)).toBe(2.0);
    }
  });

  it("gives fighters 1.5x vs naval and land targets", () => {
    expect(config.combatMultiplier(UnitType.Fighter, UnitType.Destroyer)).toBe(
      1.5,
    );
    expect(
      config.combatMultiplier(UnitType.AttackHelicopter, UnitType.DefensePost),
    ).toBe(1.5);
  });

  it("gives bombers 3.0x vs buildings and 2.5x vs naval", () => {
    expect(config.combatMultiplier(UnitType.Bomber, UnitType.City)).toBe(3.0);
    expect(config.combatMultiplier(UnitType.Bomber, UnitType.Factory)).toBe(
      3.0,
    );
    expect(config.combatMultiplier(UnitType.Bomber, UnitType.Destroyer)).toBe(
      2.5,
    );
  });

  it("gives coastal batteries 1.5x vs naval ships", () => {
    expect(
      config.combatMultiplier(UnitType.CoastalBattery, UnitType.Battleship),
    ).toBe(1.5);
    expect(
      config.combatMultiplier(UnitType.CoastalBattery, UnitType.Destroyer),
    ).toBe(1.5);
  });

  it("gives naval ships 1.5x bombardment vs shore structures", () => {
    expect(config.combatMultiplier(UnitType.Battleship, UnitType.Port)).toBe(
      1.5,
    );
    expect(
      config.combatMultiplier(UnitType.Destroyer, UnitType.DefensePost),
    ).toBe(1.5);
    expect(
      config.combatMultiplier(UnitType.Cruiser, UnitType.CoastalBattery),
    ).toBe(1.5);
  });

  it("destroyer-sub rock-paper-scissors is asymmetric (destroyers win)", () => {
    const destroyerVsSub = config.combatMultiplier(
      UnitType.Destroyer,
      UnitType.Submarine,
    );
    const subVsDestroyer = config.combatMultiplier(
      UnitType.Submarine,
      UnitType.Destroyer,
    );
    expect(destroyerVsSub).toBeGreaterThan(subVsDestroyer);
  });

  it("submarine-battleship rock-paper-scissors is asymmetric (subs win)", () => {
    const subVsBattleship = config.combatMultiplier(
      UnitType.Submarine,
      UnitType.Battleship,
    );
    const battleshipVsSub = config.combatMultiplier(
      UnitType.Battleship,
      UnitType.Submarine,
    );
    expect(subVsBattleship).toBeGreaterThan(battleshipVsSub);
  });

  it("battleship-destroyer rock-paper-scissors (battleship outguns destroyer)", () => {
    // Battleship is a capital ship — vs Destroyer, multiplier is 1.0 both ways
    // (The imbalance comes from raw damage/health, not multipliers.)
    const bVsD = config.combatMultiplier(
      UnitType.Battleship,
      UnitType.Destroyer,
    );
    const dVsB = config.combatMultiplier(
      UnitType.Destroyer,
      UnitType.Battleship,
    );
    expect(bVsD).toBe(1.0);
    expect(dVsB).toBe(1.0);
  });
});

describe("Shore bombardment range", () => {
  it("is configured for naval ships", () => {
    expect(config.shoreBombardmentRange()).toBeGreaterThan(0);
    expect(config.shoreBombardmentRange()).toBeLessThanOrEqual(100);
  });
});
