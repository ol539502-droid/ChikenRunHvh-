/**
 * How the level looks: colour tints for every surface, sky, fog and light. Purely visual and
 * local (the developer menu's World tab edits it); white tints mean "unchanged".
 */
export interface WorldLook {
  grass: string;
  /** Town pavement and the Sandbox grid. */
  ground: string;
  road: string;
  crate: string;
  hay: string;
  stone: string;
  brick: string;
  wood: string;
  roof: string;
  concrete: string;
  metal: string;
  /** Sandstown walls. */
  sandstone: string;
  fence: string;
  trees: string;
  zenith: string;
  horizon: string;
  /** 0 = clear sky, 1 = normal, up to 2 = overcast. */
  clouds: number;
  /** Multiplier on how far you can see before the fog. */
  fog: number;
  sunColor: string;
  sunIntensity: number;
  /** Multiplier on ambient (sky) light. */
  ambient: number;
  exposure: number;
  wireframe: boolean;
}

export const SURFACES = ['grass', 'ground', 'road', 'crate', 'hay', 'stone', 'brick', 'wood', 'roof', 'concrete', 'metal', 'sandstone', 'fence', 'trees'] as const;
export type Surface = (typeof SURFACES)[number];

/** The Graveyard (Zombie Apocalypse): a dark, foggy night. */
export function nightLook(): WorldLook {
  return {
    ...defaultLook(),
    grass: '#6a8078',
    ground: '#6a7078',
    road: '#5a5e66',
    crate: '#8b8f9a',
    hay: '#8b8f9a',
    stone: '#9aa3b5',
    brick: '#8b8f9a',
    wood: '#7d7568',
    roof: '#5b6070',
    concrete: '#80858f',
    metal: '#8089a0',
    sandstone: '#8b8f9a',
    fence: '#6b7080',
    trees: '#4d5a58',
    // Moonless and misty: the fog starts at 12 m and hides everything past 35 m, except
    // lanterns and zombie eyes.
    zenith: '#020308',
    horizon: '#0b0f17',
    clouds: 0,
    fog: 0.2,
    sunColor: '#6f82b8',
    sunIntensity: 0.35,
    ambient: 0.32,
    exposure: 1,
  };
}

export function defaultLook(): WorldLook {
  return {
    grass: '#ffffff',
    ground: '#ffffff',
    road: '#ffffff',
    crate: '#ffffff',
    hay: '#ffffff',
    stone: '#ffffff',
    brick: '#ffffff',
    wood: '#ffffff',
    roof: '#ffffff',
    concrete: '#ffffff',
    metal: '#ffffff',
    sandstone: '#ffffff',
    fence: '#ffffff',
    trees: '#ffffff',
    zenith: '#669fae',
    horizon: '#f1debb',
    clouds: 1,
    fog: 1,
    sunColor: '#fff0d8',
    sunIntensity: 2.6,
    ambient: 1,
    exposure: 1.15,
    wireframe: false,
  };
}
