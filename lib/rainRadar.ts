import https from "node:https";
import { PNG } from "pngjs";

// RainViewer Universal Blue, unsmoothed rain palette (snow=0), -10..64 dBZ.
// Source: https://www.rainviewer.com/api/color-schemes.html (2026-09-23).
const COLORS = (
  "63615914 66635a19 69665c1e 6c685d24 6f6b5f29 726e612e 75706234 78736439 7c75653e 7f786744 "
  + "827b6949 857d6a4e 88806c54 8b826d59 8e856f5e 92887164 9e93756e aa9e7978 b6a97e82 c2b4828c "
  + "cec08796 d2c48ba0 d6c88faa dacc93b4 ded097be 88ddeeff 6cd1ebff 51c5e8ff 36bae5ff 1baee2ff "
  + "00a3e0ff 009ad5ff 0091caff 0088bfff 007fb4ff 0077aaff 0070a3ff 00699cff 006295ff 005b8eff "
  + "005588ff 005180ff 004e78ff 004a70ff 004768ff ffee00ff ffe000ff ffd200ff ffc500ff ffb700ff "
  + "ffaa00ff ff9f00ff ff9500ff ff8b00ff ff8100ff ff4400ff f23600ff e62800ff d91b00ff cd0d00ff "
  + "c10000ff a80000ff 8f0000ff 760000ff 5d0000ff ffaaffff ff9fffff ff95ffff ff8bffff ff81ffff "
  + "ff77ffff ff6cffff ff62ffff ff58ffff ff4effff"
).split(" ");
const PALETTE = new Map(COLORS.map((color, index) => [color, index - 10]));
PALETTE.set("ffffffff", 65);
PALETTE.set("00ff00ff", 75);
const MINUTE = 60_000;
export const RADAR_MAX_AGE_MS = 20 * MINUTE;
const MAX_GAP_MS = 15 * MINUTE;
const TILE_HOST = "https://tilecache.rainviewer.com";
const MANIFEST_URL = "https://api.rainviewer.com/public/weather-maps.json";

export type RadarPoint = { time: number; dbz: number };
export type RadarHistory = { key: string; points: RadarPoint[] };
export type RadarState = "disabled" | "unknown" | "rain" | "drying" | "dry";
export type RadarSnapshot = {
  state: RadarState;
  frameTime?: number;
  dbz?: number;
  remainingMinutes?: number;
  detail: string;
};
export type RadarConfig = { enabled: boolean; threshold: number; dryingMinutes: number };
type Location = { latitude: number; longitude: number };
type Tile = { x: number; y: number; px: number; py: number; key: string };
type Frame = { time: number; path: string };

export function radarTile({ latitude, longitude }: Location): Tile {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 85
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Homey location is not configured or is outside radar map limits");
  }
  const x = ((longitude + 180) / 360 * 128) % 128;
  const lat = latitude * Math.PI / 180;
  const y = (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * 128;
  const tile = { x: Math.floor(x), y: Math.floor(y), px: Math.floor((x % 1) * 256), py: Math.floor((y % 1) * 256) };
  return { ...tile, key: `7/${tile.x}/${tile.y}/${tile.px}/${tile.py}` };
}

export function readRadarPixel(buffer: Buffer, tile: Pick<Tile, "px" | "py">): Buffer {
  // Bound dimensions before decompression; reject unexpected/huge remote PNGs.
  if (buffer.length < 33 || buffer.length > 1024 * 1024
    || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR"
    || buffer.readUInt32BE(16) !== 256 || buffer.readUInt32BE(20) !== 256
    || !Number.isInteger(tile.px) || tile.px < 0 || tile.px > 255
    || !Number.isInteger(tile.py) || tile.py < 0 || tile.py > 255) {
    throw new Error("Invalid radar tile");
  }
  const png = PNG.sync.read(buffer, { checkCRC: true });
  const index = (tile.py * 256 + tile.px) * 4;
  return png.data.subarray(index, index + 4);
}

export function radarReflectivity(pixel: Buffer): number {
  if (pixel.length !== 4) throw new Error("Invalid radar pixel");
  if (pixel[3] === 0) return -32;
  const dbz = PALETTE.get(pixel.toString("hex"));
  if (dbz === undefined) throw new Error("Unknown RainViewer palette colour");
  return dbz;
}

export function parseRadarFrames(input: unknown, now: number): Frame[] {
  const data = input as { host?: unknown; radar?: { past?: unknown } } | null;
  if (!data || data.host !== TILE_HOST || !Array.isArray(data.radar?.past)) {
    throw new Error("Invalid RainViewer manifest");
  }
  const frames: Frame[] = data.radar.past.map((frame: unknown) => {
    const value = frame as { time?: unknown; path?: unknown } | null;
    if (!value || typeof value.time !== "number" || !Number.isSafeInteger(value.time)
      || typeof value.path !== "string" || !/^\/v2\/radar\/[a-zA-Z0-9_-]+$/.test(value.path)
      || value.time * 1000 > now + MINUTE || value.time * 1000 < now - 3 * 60 * MINUTE) {
      throw new Error("Invalid RainViewer frame");
    }
    return { time: value.time * 1000, path: value.path };
  }).sort((a, b) => a.time - b.time);
  if (!frames.length || frames.length > 24
    || new Set(frames.map((frame) => frame.time)).size !== frames.length
    || now - frames[frames.length - 1].time > RADAR_MAX_AGE_MS) {
    throw new Error("Radar frames are missing or stale");
  }
  return frames;
}

export function evaluateRadar(points: RadarPoint[], config: RadarConfig, now: number): RadarSnapshot {
  if (!config.enabled) return { state: "disabled", detail: "Radar is disabled in device settings" };
  const latest = points[points.length - 1];
  if (!latest || latest.time > now + MINUTE || now - latest.time > RADAR_MAX_AGE_MS) {
    return { state: "unknown", frameTime: latest?.time, detail: "No fresh radar data; not evidence of rain" };
  }
  const base = { frameTime: latest.time, dbz: latest.dbz };
  if (latest.dbz >= config.threshold) return { ...base, state: "rain", detail: "RainViewer detects precipitation at the Homey location" };
  let firstDry = latest.time;
  let rainBeforeDry = false;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const point = points[i];
    if (firstDry - point.time > MAX_GAP_MS) break;
    if (point.dbz >= config.threshold) { rainBeforeDry = true; break; }
    firstDry = point.time;
  }
  // Only observed dry frames count, not elapsed wall time during a radar outage.
  const remainingMinutes = Math.max(0, Math.ceil(config.dryingMinutes - (latest.time - firstDry) / MINUTE));
  if (!remainingMinutes) return { ...base, state: "dry", remainingMinutes: 0, detail: "Radar dry interval confirmed" };
  return {
    ...base, state: rainBeforeDry ? "drying" : "unknown", remainingMinutes,
    detail: rainBeforeDry ? "Waiting for the lawn drying interval after radar rain" : "Checking continuous dry radar history",
  };
}

export function downloadRadar(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["api.rainviewer.com", "tilecache.rainviewer.com"].includes(parsed.hostname)
    || parsed.port || parsed.username || parsed.password) return Promise.reject(new Error("Untrusted radar URL"));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "Homey-Mammotion-Radar/1.0" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Radar HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error("Radar response too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    // Absolute deadline also covers stalled DNS/TLS/body reads. No redirects.
    const deadline = setTimeout(() => request.destroy(new Error("Radar request timed out")), 12_000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
  });
}

export class RainRadar {
  private history: RadarHistory = { key: "", points: [] };
  private coveredKey?: string;
  private timer?: NodeJS.Timeout;
  private active = false;
  private pending?: Promise<void>;
  private nextFetch = 0;
  private lastError = "Waiting for radar data";
  private currentLocationKey?: string;

  constructor(private readonly options: {
    config: RadarConfig;
    location: () => Location;
    stored?: unknown;
    publish: (snapshot: RadarSnapshot, history: RadarHistory) => Promise<void>;
    download?: typeof downloadRadar;
    now?: () => number;
    error: (error: unknown) => void;
  }) {
    const stored = options.stored as Partial<RadarHistory> | undefined;
    if (typeof stored?.key === "string" && Array.isArray(stored.points)) {
      const points = stored.points.filter((p) => p && Number.isFinite(p.time) && Number.isFinite(p.dbz)
        && p.dbz >= -32 && p.dbz <= 95 && p.time <= this.now() + MINUTE && p.time >= this.now() - 12 * 60 * MINUTE);
      this.history = { key: stored.key, points: [...new Map(points.map((p) => [p.time, p])).values()].sort((a, b) => a.time - b.time).slice(-64) };
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  snapshot(): RadarSnapshot {
    if (this.options.config.enabled && (!this.currentLocationKey || this.currentLocationKey !== this.history.key
      || this.coveredKey !== this.currentLocationKey)) {
      return { state: "unknown", detail: this.lastError };
    }
    const result = evaluateRadar(this.history.points, this.options.config, this.now());
    if (result.state === "unknown" && this.lastError) result.detail = this.lastError;
    return result;
  }

  start(): void {
    this.stop();
    this.active = true;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, MINUTE);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async update(): Promise<void> {
    try {
      if (this.options.config.enabled) {
        this.currentLocationKey = undefined;
        const tile = radarTile(this.options.location());
        this.currentLocationKey = tile.key;
        if (this.history.key !== tile.key) {
          this.history = { key: tile.key, points: [] };
          this.nextFetch = 0;
        }
        if (this.now() >= this.nextFetch) {
          const download = this.options.download ?? downloadRadar;
          if (this.coveredKey !== tile.key) {
            const coverage = readRadarPixel(await download(`${TILE_HOST}/v2/coverage/0/256/7/${tile.x}/${tile.y}/0/0_0.png`), tile);
            if (coverage[3] !== 0) throw new Error("Homey location has no confirmed radar coverage");
            this.coveredKey = tile.key;
          }
          if (!this.active) return;
          const frames = parseRadarFrames(JSON.parse((await download(MANIFEST_URL)).toString("utf8")), this.now());
          const known = new Map(this.history.points.map((point) => [point.time, point]));
          // Newest first: if an older download fails we still retain the latest rain observation.
          for (const frame of [...frames].reverse()) {
            if (!this.active) return;
            if (!known.has(frame.time)) {
              const image = await download(`${TILE_HOST}${frame.path}/256/7/${tile.x}/${tile.y}/2/0_0.png`);
              known.set(frame.time, { time: frame.time, dbz: radarReflectivity(readRadarPixel(image, tile)) });
              this.history.points = [...known.values()].sort((a, b) => a.time - b.time).slice(-64);
              if (this.active && frame.time === frames[frames.length - 1].time
                && this.snapshot().state === "rain") {
                await this.options.publish(this.snapshot(), this.history);
              }
            }
          }
          this.nextFetch = this.now() + 5 * MINUTE;
          this.lastError = "";
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Radar unavailable";
      // Retain history, but a failed check must not grant a new start/resume.
      this.currentLocationKey = undefined;
      this.options.error(error);
    }
    if (this.active) {
      try { await this.options.publish(this.snapshot(), this.history); }
      catch (error) { this.options.error(error); }
    }
  }
}
