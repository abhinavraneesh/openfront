import { Game, Player, Unit, UnitMission, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";

export const NAVAL_REPAIR_RATE = 2;

export const REPAIRABLE_SHIP_TYPES = [
  UnitType.Warship,
  UnitType.Destroyer,
  UnitType.Cruiser,
  UnitType.Battleship,
  UnitType.Submarine,
  UnitType.Minelayer,
  UnitType.Carrier,
] as const;

export function isRepairableShip(type: UnitType): boolean {
  return (REPAIRABLE_SHIP_TYPES as readonly UnitType[]).includes(type);
}

export function ensureShipHomePort(mg: Game, ship: Unit): Unit | undefined {
  const current = ship.patrolTile();
  const owner = ship.owner();
  const currentPort =
    current === undefined
      ? undefined
      : owner
          .units(UnitType.Port)
          .find(
            (port) =>
              port.tile() === current &&
              port.isActive() &&
              !port.isUnderConstruction(),
          );

  if (currentPort !== undefined) {
    return currentPort;
  }

  const nearest = nearestFriendlyPort(mg, owner, ship.tile());
  ship.setPatrolTile(nearest?.tile());
  return nearest;
}

export function repairShipIfDocked(mg: Game, ship: Unit): void {
  if (!ship.hasHealth()) return;

  const maxHealth = Number(mg.config().unitInfo(ship.type()).maxHealth ?? 0);
  if (maxHealth <= 0 || ship.health() >= maxHealth) return;

  const homePort = ensureShipHomePort(mg, ship);
  if (homePort === undefined) return;
  if (!isDockedAtHomePort(ship, homePort.tile())) return;
  if (!hasNavalYardForPort(mg, ship.owner(), homePort.tile())) return;

  ship.modifyHealth(Math.min(NAVAL_REPAIR_RATE, maxHealth - ship.health()));
}

export function isDockedAtHomePort(ship: Unit, homePortTile: TileRef): boolean {
  if (ship.tile() !== homePortTile) return false;
  const mission = ship.mission();
  return (
    mission === UnitMission.RETURN_TO_PORT ||
    mission === UnitMission.HOLD_POSITION
  );
}

export function hasNavalYardForPort(
  mg: Game,
  owner: Player,
  portTile: TileRef,
): boolean {
  return mg
    .nearbyUnits(portTile, 30, UnitType.NavalYard, undefined, true)
    .some(
      ({ unit }) =>
        unit.owner() === owner &&
        unit.isActive() &&
        !unit.isUnderConstruction(),
    );
}

function nearestFriendlyPort(
  mg: Game,
  owner: Player,
  from: TileRef,
): Unit | undefined {
  let best: Unit | undefined;
  let bestDist = Infinity;

  for (const port of owner.units(UnitType.Port)) {
    if (!port.isActive() || port.isUnderConstruction()) continue;
    const dist = mg.euclideanDistSquared(from, port.tile());
    if (dist < bestDist) {
      best = port;
      bestDist = dist;
    }
  }

  return best;
}
