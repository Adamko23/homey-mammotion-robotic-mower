import type { MammotionStartMowingSettings } from "./mammotionProtocol";

export type MammotionStartMowingFlowArgs = {
  blade_height?: unknown;
  border_laps?: unknown;
  channel_mode?: unknown;
  cutting_path_angle?: unknown;
  cutting_path_angle_mode?: unknown;
  mow_order?: unknown;
  obstacle_detection?: unknown;
  obstacle_laps?: unknown;
  path_spacing?: unknown;
  speed?: unknown;
};

export type MammotionStartMowingOptions = {
  cuttingPathAngleMode?: number;
  defaultCuttingPathAngleMode?: number;
};

function getNumber(value: unknown, fallback: number, title: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    throw new Error(`${title} must be a number.`);
  }

  return parsed;
}

function getNumberInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  title: string,
): number {
  const parsed = getNumber(value, fallback, title);

  if (parsed < min || parsed > max) {
    throw new Error(`${title} must be between ${min} and ${max}.`);
  }

  return parsed;
}

function getIntegerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  title: string,
): number {
  const parsed = getNumberInRange(value, fallback, min, max, title);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${title} must be a whole number.`);
  }

  return parsed;
}

function getIntegerOption(
  value: unknown,
  fallback: number,
  allowed: readonly number[],
  title: string,
): number {
  const parsed = getNumber(value, fallback, title);

  if (!Number.isInteger(parsed) || !allowed.includes(parsed)) {
    throw new Error(`${title} must be one of: ${allowed.join(", ")}.`);
  }

  return parsed;
}

export function normalizeStartMowingSettings(
  args: MammotionStartMowingFlowArgs,
  areaHashes: bigint[],
  options: MammotionStartMowingOptions = {},
): MammotionStartMowingSettings {
  return {
    areaHashes,
    bladeHeight: getIntegerInRange(args.blade_height, 50, 25, 70, "Blade height"),
    borderLaps: getIntegerInRange(args.border_laps, 1, 0, 4, "Border laps"),
    channelMode: getIntegerOption(args.channel_mode, 0, [0, 1, 2, 3], "Mowing pattern"),
    channelWidth: getIntegerInRange(args.path_spacing, 25, 20, 35, "Path spacing"),
    cuttingPathAngle: getIntegerInRange(args.cutting_path_angle, 0, -180, 180, "Cutting path angle"),
    cuttingPathAngleMode: options.cuttingPathAngleMode
      ?? getIntegerOption(
        args.cutting_path_angle_mode,
        options.defaultCuttingPathAngleMode ?? 0,
        [0, 1, 2],
        "Cutting path angle mode",
      ),
    mowOrder: getIntegerOption(args.mow_order, 0, [0, 1], "Mow order"),
    obstacleDetection: getIntegerOption(args.obstacle_detection, 0, [0, 10, 11], "Obstacle detection"),
    obstacleLaps: getIntegerInRange(args.obstacle_laps, 1, 0, 4, "Obstacle laps"),
    speed: getNumberInRange(args.speed, 0.3, 0.2, 0.6, "Speed"),
    startProgress: 0,
  };
}
