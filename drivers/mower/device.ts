import { OAuth2Device } from "homey-oauth2app";

import MammotionOAuth2Client from "../../lib/MammotionOAuth2Client";
import {
  MammotionTaskAction,
  type MammotionArea,
  type MammotionCommandTarget,
  type MammotionStartMowingSettings,
  type MammotionTelemetry,
} from "../../lib/mammotionProtocol";

type MowerStore = {
  areas?: unknown;
  deviceId?: unknown;
  deviceName?: unknown;
  deviceType?: unknown;
  iotId?: unknown;
  productKey?: unknown;
  productSeries?: unknown;
  recordDeviceName?: unknown;
  series?: unknown;
};
type AreaAutocompleteResult = {
  all?: boolean;
  description?: string;
  hash?: string;
  hashes?: string[];
  id: string;
  name: string;
};
type MammotionCommandSource = "homey_control" | "homey_flow";
type MammotionState =
  | "unknown"
  | "ready"
  | "mowing"
  | "returning"
  | "charging"
  | "paused"
  | "locked"
  | "manual"
  | "initializing"
  | "updating"
  | "disabled"
  | "offline"
  | "powered_off"
  | "location_error"
  | "editing"
  | "error";

const COMMAND_CAPABILITIES = [
  "mammotion_pause",
  "mammotion_resume",
  "mammotion_cancel",
  "mammotion_dock",
] as const;

const COMMAND_NAMES = ["start", "pause", "resume", "cancel", "dock", "schedule"] as const;
const COMMAND_ACTIVITY_CAPABILITIES = COMMAND_NAMES.flatMap((command) => [
  `mammotion_command_${command}_homey_control`,
  `mammotion_command_${command}_homey_flow`,
]);

const LEGACY_CAPABILITIES = [
  "button.pause_mowing",
  "button.resume_mowing",
  "button.cancel_mowing",
  "button.return_to_dock",
  "button.start_mowing",
  "button.run_schedule",
] as const;

const STATUS_CAPABILITIES = [
  "mammotion_state",
  "measure_battery",
  "mammotion_connection",
  "mammotion_charge_status",
  "mammotion_progress",
  "mammotion_current_zone",
  "mammotion_blade_height",
  "mammotion_wifi_rssi",
  "mammotion_rtk_status",
  "mammotion_rtk_satellites",
  "mammotion_cutter_rpm",
  "mammotion_error_code",
  "mammotion_total_distance",
  "mammotion_total_work_time",
  "mammotion_battery_cycles",
  "mammotion_blade_work_time",
  "mammotion_firmware",
  "mammotion_last_command",
  "mammotion_last_update",
  "mammotion_activity_connection",
  "mammotion_activity_mowing",
  "mammotion_activity_paused",
  "mammotion_activity_returning",
  "mammotion_activity_charging",
  "mammotion_activity_ready",
  "mammotion_activity_locked",
  "mammotion_activity_error",
  "mammotion_activity_manual",
  "mammotion_command_start",
  "mammotion_command_pause",
  "mammotion_command_resume",
  "mammotion_command_cancel",
  "mammotion_command_dock",
  "mammotion_command_schedule",
  ...COMMAND_ACTIVITY_CAPABILITIES,
] as const;

const TELEMETRY_STALE_MS = 3 * 60_000;
const TELEMETRY_REFRESH_MS = 60_000;
const ACTIVE_STATES = new Set<MammotionState>(["mowing", "paused", "returning"]);
const STATE_ACTIVITY_CAPABILITY: Partial<Record<MammotionState, string>> = {
  charging: "mammotion_activity_charging",
  error: "mammotion_activity_error",
  location_error: "mammotion_activity_error",
  locked: "mammotion_activity_locked",
  manual: "mammotion_activity_manual",
  mowing: "mammotion_activity_mowing",
  paused: "mammotion_activity_paused",
  ready: "mammotion_activity_ready",
  returning: "mammotion_activity_returning",
};

function stateFromCode(code: number | undefined, errorCode: number | undefined): MammotionState {
  switch (code) {
    case 1:
    case 11:
    case 22:
      return "ready";
    case 2:
      return "offline";
    case 3:
      return "powered_off";
    case 8:
      return "disabled";
    case 10:
      return "initializing";
    case 13:
      return "mowing";
    case 14:
      return "returning";
    case 15:
      return "charging";
    case 16:
      return "updating";
    case 17:
      return "locked";
    case 19:
    case 39:
      return "paused";
    case 20:
      return "manual";
    case 23:
      return "error";
    case 31:
    case 32:
    case 34:
    case 35:
    case 36:
      return "editing";
    case 37:
    case 38:
      return "location_error";
    default:
      return errorCode && errorCode !== 0 ? "error" : "unknown";
  }
}

function rtkStatusFromPositionLevel(level: number): string {
  switch (level) {
    case 0:
      return "rtk_fixed";
    case 1:
    case 2:
      return "degraded";
    case 3:
      return "no_position";
    default:
      return "unknown";
  }
}

function commandSourceTitle(source: MammotionCommandSource): string {
  return source === "homey_flow" ? "Homey Flow" : "Homey control";
}

function getStoreString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStoreDeviceType(value: unknown): number | string | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return getStoreString(value);
}

function normalizeAreas(value: unknown): MammotionArea[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const areasByHash = new Map<string, MammotionArea>();

  for (const area of value) {
    if (!area || typeof area !== "object") {
      continue;
    }

    const hash = getStoreString((area as { hash?: unknown }).hash);
    const name = getStoreString((area as { name?: unknown }).name);

    if (!hash || !name) {
      continue;
    }

    try {
      BigInt(hash);
      areasByHash.set(hash, { hash, name });
    } catch {
      // Ignore malformed hashes stored by older/dev builds.
    }
  }

  return [...areasByHash.values()].sort((first, second) => first.name.localeCompare(second.name, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

function normalizeAreaName(value: string): string {
  return value.trim().toLowerCase();
}

class MowerDevice extends OAuth2Device {
  private hasLoggedTelemetrySnapshot = false;
  private telemetryRefreshFailures = 0;
  private telemetryRefreshTimer?: NodeJS.Timeout;
  private telemetryStaleTimer?: NodeJS.Timeout;
  private unsubscribeTelemetry?: () => void;
  private telemetryQueue: Promise<void> = Promise.resolve();

  async onOAuth2Init(): Promise<void> {
    await this.refreshCommandStore();
    await this.ensureCommandCapabilities();
    await this.ensureStatusCapabilities();
    await this.removeLegacyCapabilities();
    this.registerCommandCapabilityListeners();
    await this.initializeStatusCapabilities();
    await this.setAvailable();
    this.unsubscribeTelemetry = await this.getMammotionClient().subscribeTelemetry({
      listener: (telemetry) => {
        this.telemetryQueue = this.telemetryQueue
          .then(() => this.applyTelemetry(telemetry))
          .catch((error: unknown) => {
            this.error("Could not apply Mammotion telemetry", error);
          });
      },
      target: this.getCommandTarget(),
    });
    this.telemetryRefreshTimer = setInterval(() => {
      if (["editing", "locked", "manual", "updating"].includes(
        String(this.getCapabilityValue("mammotion_state") || "unknown"),
      )) {
        return;
      }

      void this.getMammotionClient().refreshTelemetry(this.getCommandTarget())
        .then(() => {
          this.telemetryRefreshFailures = 0;
        })
        .catch((error: unknown) => {
          this.telemetryRefreshFailures += 1;
          this.error("Could not refresh Mammotion mower telemetry", {
            consecutiveFailures: this.telemetryRefreshFailures,
            message: error instanceof Error ? error.message : String(error),
          });

          if (this.telemetryRefreshFailures >= 2
            && this.getCapabilityValue("mammotion_connection") === "stale") {
            void this.markTelemetryOffline();
          }
        });
    }, TELEMETRY_REFRESH_MS);
    this.log("Mammotion mower initialized", this.getData());
  }

  async onOAuth2Uninit(): Promise<void> {
    this.stopTelemetryMonitoring();
  }

  async onOAuth2Deleted(): Promise<void> {
    this.stopTelemetryMonitoring();
    this.log("Mammotion mower deleted", this.getData());
  }

  async startMowing(
    settings: MammotionStartMowingSettings,
    source: MammotionCommandSource = "homey_flow",
  ): Promise<void> {
    await this.getMammotionClient().startMowing({
      settings,
      target: this.getCommandTarget(),
    });
    await this.recordCommand("start", "Start mowing", source);
  }

  async pauseMowing(source: MammotionCommandSource = "homey_control"): Promise<void> {
    await this.sendTaskControl(MammotionTaskAction.Pause, "pause", "Pause", source);
  }

  async resumeMowing(source: MammotionCommandSource = "homey_control"): Promise<void> {
    await this.sendTaskControl(MammotionTaskAction.Resume, "resume", "Resume", source);
  }

  async cancelMowing(source: MammotionCommandSource = "homey_control"): Promise<void> {
    await this.sendTaskControl(MammotionTaskAction.Cancel, "cancel", "Cancel mowing", source);
  }

  async returnToDock(source: MammotionCommandSource = "homey_control"): Promise<void> {
    await this.sendTaskControl(MammotionTaskAction.ReturnToDock, "dock", "Return to dock", source);
  }

  async runSchedule(planId: string, source: MammotionCommandSource = "homey_flow"): Promise<void> {
    await this.getMammotionClient().executeSchedule({
      planId,
      target: this.getCommandTarget(),
    });
    await this.recordCommand("schedule", `Run schedule ${planId}`, source);
  }

  async refreshAreas(): Promise<MammotionArea[]> {
    const areas = await this.getMammotionClient().refreshAreas({
      target: this.getCommandTarget(),
    });

    if (areas.length) {
      await this.setStoreValue("areas", areas);
    }

    this.log("Mammotion mower areas refreshed", {
      count: areas.length,
      stored: areas.length || this.getStoredAreas().length,
    });

    return areas;
  }

  getStoredAreas(): MammotionArea[] {
    return normalizeAreas((this.getStore() as MowerStore).areas);
  }

  async autocompleteArea(query: string): Promise<AreaAutocompleteResult[]> {
    const storedAreas = this.getStoredAreas();
    const areas = storedAreas.length ? storedAreas : await this.refreshAreas();
    const normalizedQuery = query.trim().toLowerCase();
    const results: AreaAutocompleteResult[] = [];

    if (areas.length > 1) {
      results.push({
        all: true,
        description: `${areas.length} Mammotion zones`,
        hashes: areas.map((area) => area.hash),
        id: "__all__",
        name: "All known zones",
      });
    }

    results.push(...areas.map((area) => ({
      description: area.hash,
      hash: area.hash,
      hashes: [area.hash],
      id: area.hash,
      name: area.name,
    })));

    if (!normalizedQuery) {
      return results;
    }

    return results.filter((result) => {
      const haystack = `${result.name} ${result.description || ""} ${result.id}`.toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }

  async resolveAreaSelection(input: string): Promise<bigint[]> {
    const normalizedInput = normalizeAreaName(input);

    if (!normalizedInput) {
      return [];
    }

    const areas = this.getStoredAreas().length ? this.getStoredAreas() : await this.refreshAreas();

    if (["*", "all", "all known zones"].includes(normalizedInput)) {
      return areas.map((area) => BigInt(area.hash));
    }

    const exactMatches = areas.filter((area) => normalizeAreaName(area.name) === normalizedInput
      || normalizeAreaName(area.hash) === normalizedInput);

    if (exactMatches.length === 1) {
      return [BigInt(exactMatches[0].hash)];
    }

    if (exactMatches.length > 1) {
      throw new Error(`Mammotion area name is ambiguous: ${input}`);
    }

    const partialMatches = areas.filter((area) => normalizeAreaName(area.name).includes(normalizedInput));

    if (partialMatches.length === 1) {
      return [BigInt(partialMatches[0].hash)];
    }

    if (partialMatches.length > 1) {
      throw new Error(`Mammotion area name matches multiple zones: ${partialMatches.map((area) => area.name).join(", ")}`);
    }

    throw new Error(`Mammotion area "${input}" is not known. Run Refresh mower zones or paste the area hash ID.`);
  }

  private async sendTaskControl(
    action: MammotionTaskAction,
    command: "pause" | "resume" | "cancel" | "dock",
    title: string,
    source: MammotionCommandSource,
  ): Promise<void> {
    await this.getMammotionClient().sendTaskControl({
      action,
      target: this.getCommandTarget(),
    });
    await this.recordCommand(command, title, source);
  }

  private getCommandTarget(): MammotionCommandTarget {
    const store = this.getStore() as MowerStore;
    const iotId = getStoreString(store.iotId);

    if (!iotId) {
      throw new Error("Mammotion device does not contain an iotId");
    }

    return {
      deviceName: getStoreString(store.deviceName),
      deviceType: getStoreDeviceType(store.deviceType),
      iotId,
      productKey: getStoreString(store.productKey),
      productSeries: getStoreString(store.productSeries),
      recordDeviceName: getStoreString(store.recordDeviceName) || getStoreString(store.deviceName),
      series: getStoreString(store.series),
    };
  }

  private getMammotionClient(): MammotionOAuth2Client {
    return this.oAuth2Client as MammotionOAuth2Client;
  }

  private async applyTelemetry(telemetry: MammotionTelemetry): Promise<void> {
    this.telemetryRefreshFailures = 0;
    const previousConnection = this.getCapabilityValue("mammotion_connection");
    const previousStateValue = this.getCapabilityValue("mammotion_state");
    const previousState = typeof previousStateValue === "string"
      ? previousStateValue as MammotionState
      : "unknown";
    const nextState = telemetry.stateCode !== undefined || (telemetry.errorCode || 0) !== 0
      ? stateFromCode(telemetry.stateCode, telemetry.errorCode)
      : previousState;

    this.armTelemetryStaleTimer(telemetry.receivedAt);
    await this.setCapabilitySafely("mammotion_connection", "connected");
    await this.setConnectionTimelineActivity(true);

    if (nextState === "offline" || nextState === "powered_off") {
      await this.setUnavailable(nextState === "offline"
        ? "Mammotion reports that the mower is offline"
        : "Mammotion reports that the mower is powered off");
    } else {
      await this.setAvailable();
    }

    if (telemetry.batteryPercent !== undefined) {
      await this.setCapabilitySafely("measure_battery", Math.max(0, Math.min(100, telemetry.batteryPercent)));
    }
    if (telemetry.mowingProgressPercent !== undefined) {
      await this.setCapabilitySafely(
        "mammotion_progress",
        Math.max(0, Math.min(100, telemetry.mowingProgressPercent)),
      );
    }
    if (telemetry.bladeHeightMm !== undefined) {
      await this.setCapabilitySafely("mammotion_blade_height", telemetry.bladeHeightMm);
    }
    if (telemetry.wifiRssi !== undefined && telemetry.wifiRssi <= 0 && telemetry.wifiRssi >= -120) {
      await this.setCapabilitySafely("mammotion_wifi_rssi", telemetry.wifiRssi);
    }
    if (telemetry.rtkPositionLevel !== undefined) {
      await this.setCapabilitySafely("mammotion_rtk_status", rtkStatusFromPositionLevel(telemetry.rtkPositionLevel));
    }
    if (telemetry.rtkSatellites !== undefined) {
      await this.setCapabilitySafely("mammotion_rtk_satellites", telemetry.rtkSatellites);
    }
    if (telemetry.cutterRpm !== undefined) {
      await this.setCapabilitySafely("mammotion_cutter_rpm", telemetry.cutterRpm);
    }
    if (telemetry.errorCode !== undefined) {
      await this.setCapabilitySafely("mammotion_error_code", telemetry.errorCode);
    }
    if (telemetry.totalMileageMeters !== undefined) {
      await this.setCapabilitySafely("mammotion_total_distance", telemetry.totalMileageMeters / 1_000);
    }
    if (telemetry.totalWorkTimeSeconds !== undefined) {
      await this.setCapabilitySafely("mammotion_total_work_time", telemetry.totalWorkTimeSeconds / 3_600);
    }
    if (telemetry.batteryCycles !== undefined) {
      await this.setCapabilitySafely("mammotion_battery_cycles", telemetry.batteryCycles);
    }
    if (telemetry.bladeWorkTimeSeconds !== undefined) {
      await this.setCapabilitySafely("mammotion_blade_work_time", telemetry.bladeWorkTimeSeconds / 3_600);
    }
    if (telemetry.firmwareVersion) {
      await this.setCapabilitySafely("mammotion_firmware", telemetry.firmwareVersion);
    }

    if (telemetry.chargeState !== undefined) {
      const battery = telemetry.batteryPercent
        ?? (typeof this.getCapabilityValue("measure_battery") === "number"
          ? this.getCapabilityValue("measure_battery") as number
          : undefined);
      const chargeStatus = telemetry.chargeState === 0
        ? "not_docked"
        : battery !== undefined && battery >= 100
          ? "docked_full"
          : nextState === "charging" || (battery !== undefined && battery < 100)
            ? "charging"
            : "docked";
      await this.setCapabilitySafely("mammotion_charge_status", chargeStatus);
    }

    if (telemetry.zoneHash) {
      const area = this.getStoredAreas().find((candidate) => candidate.hash === telemetry.zoneHash);
      await this.setCapabilitySafely("mammotion_current_zone", area?.name || telemetry.zoneHash);
    } else if (!ACTIVE_STATES.has(nextState) && nextState !== "manual") {
      await this.setCapabilitySafely("mammotion_current_zone", "—");
    }

    await this.setCapabilitySafely("mammotion_state", nextState);
    const updateParts = [
      new Date(telemetry.receivedAt).toISOString(),
      `${nextState} (${telemetry.stateCode ?? "-"})`,
    ];
    if (telemetry.batteryPercent !== undefined) {
      updateParts.push(`${telemetry.batteryPercent}%`);
    }
    await this.setCapabilitySafely("mammotion_last_update", updateParts.join(" · "));

    if (!this.hasLoggedTelemetrySnapshot) {
      this.hasLoggedTelemetrySnapshot = true;
      this.log("Mammotion mower telemetry snapshot", {
        batteryCycles: telemetry.batteryCycles,
        batteryPercent: telemetry.batteryPercent,
        bladeHeightMm: telemetry.bladeHeightMm,
        bladeWorkTimeSeconds: telemetry.bladeWorkTimeSeconds,
        chargeState: telemetry.chargeState,
        cutterRpm: telemetry.cutterRpm,
        errorCode: telemetry.errorCode,
        firmwareVersion: telemetry.firmwareVersion,
        mowingProgressPercent: telemetry.mowingProgressPercent,
        rtkPositionLevel: telemetry.rtkPositionLevel,
        rtkSatellites: telemetry.rtkSatellites,
        stateCode: telemetry.stateCode,
        totalMileageMeters: telemetry.totalMileageMeters,
        totalWorkTimeSeconds: telemetry.totalWorkTimeSeconds,
        wifiRssi: telemetry.wifiRssi,
        zoneHash: telemetry.zoneHash,
      });
    }

    if (previousState !== nextState) {
      await this.recordStateTransition(previousState, nextState, telemetry);
    }

    if (previousConnection !== "connected") {
      this.log("Mammotion mower status connection restored", {
        iotId: this.getCommandTarget().iotId,
      });
    }
  }

  private async recordStateTransition(
    previousState: MammotionState,
    nextState: MammotionState,
    telemetry: MammotionTelemetry,
  ): Promise<void> {
    const activityCapability = STATE_ACTIVITY_CAPABILITY[nextState];

    if (activityCapability) {
      await this.toggleActivityCapability(activityCapability);
    }

    const commonTokens = {
      ...(telemetry.batteryPercent !== undefined ? { battery: telemetry.batteryPercent } : {}),
      ...(telemetry.zoneHash ? {
        zone: this.getStoredAreas().find((area) => area.hash === telemetry.zoneHash)?.name || telemetry.zoneHash,
      } : {}),
    };
    const stateTokens = {
      ...commonTokens,
      previous_state: previousState,
      state: nextState,
      state_code: telemetry.stateCode ?? -1,
    };

    await this.triggerDeviceFlow("mower_state_changed", stateTokens, { state: nextState });

    if (nextState === "mowing") {
      await this.triggerDeviceFlow("mowing_started", commonTokens);
    } else if (nextState === "paused") {
      await this.triggerDeviceFlow("mowing_paused", commonTokens);
    } else if (nextState === "returning") {
      await this.triggerDeviceFlow("returning_to_dock", {
        ...(telemetry.batteryPercent !== undefined ? { battery: telemetry.batteryPercent } : {}),
      });
    }

    if (ACTIVE_STATES.has(previousState) && !ACTIVE_STATES.has(nextState)) {
      await this.triggerDeviceFlow("mowing_stopped", {
        ...(telemetry.batteryPercent !== undefined ? { battery: telemetry.batteryPercent } : {}),
        state: nextState,
      });
    }

    this.log("Mammotion mower state changed", {
      batteryPercent: telemetry.batteryPercent,
      errorCode: telemetry.errorCode,
      bladeHeightMm: telemetry.bladeHeightMm,
      chargeState: telemetry.chargeState,
      cutterRpm: telemetry.cutterRpm,
      from: previousState,
      mowingProgressPercent: telemetry.mowingProgressPercent,
      rtkPositionLevel: telemetry.rtkPositionLevel,
      rtkSatellites: telemetry.rtkSatellites,
      stateCode: telemetry.stateCode,
      to: nextState,
      totalMileageMeters: telemetry.totalMileageMeters,
      totalWorkTimeSeconds: telemetry.totalWorkTimeSeconds,
      wifiRssi: telemetry.wifiRssi,
      zoneHash: telemetry.zoneHash,
    });
  }

  private async triggerDeviceFlow(
    id: string,
    tokens: Record<string, unknown>,
    state: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, state);
    } catch (error) {
      this.error(`Could not trigger Mammotion Flow ${id}`, error);
    }
  }

  private armTelemetryStaleTimer(receivedAt: number): void {
    if (this.telemetryStaleTimer) {
      clearTimeout(this.telemetryStaleTimer);
    }

    const delay = Math.max(1_000, receivedAt + TELEMETRY_STALE_MS - Date.now());
    this.telemetryStaleTimer = setTimeout(() => {
      this.telemetryStaleTimer = undefined;
      void this.markTelemetryStale();
    }, delay);
  }

  private async markTelemetryStale(): Promise<void> {
    if (this.getCapabilityValue("mammotion_connection") === "stale") {
      return;
    }

    await this.setCapabilitySafely("mammotion_connection", "stale");
    await this.setConnectionTimelineActivity(false);

    this.log("Mammotion mower telemetry became stale", {
      consecutiveRefreshFailures: this.telemetryRefreshFailures,
      iotId: this.getCommandTarget().iotId,
      timeoutMs: TELEMETRY_STALE_MS,
    });

    if (this.telemetryRefreshFailures >= 2) {
      await this.markTelemetryOffline();
    }
  }

  private async markTelemetryOffline(): Promise<void> {
    const previousStateValue = this.getCapabilityValue("mammotion_state");
    const previousState = typeof previousStateValue === "string"
      ? previousStateValue as MammotionState
      : "unknown";
    const now = Date.now();

    await this.setCapabilitySafely("mammotion_state", "offline");
    await this.setUnavailable("Mammotion status is stale and cloud refreshes are failing");

    if (previousState !== "offline") {
      await this.recordStateTransition(previousState, "offline", {
        online: true,
        receivedAt: now,
      });
    }
  }

  private async recordCommand(
    command: "start" | "pause" | "resume" | "cancel" | "dock" | "schedule",
    title: string,
    source: MammotionCommandSource,
  ): Promise<void> {
    const timestamp = new Date().toISOString();

    await this.setCapabilitySafely(
      "mammotion_last_command",
      `${timestamp} · ${title} · ${commandSourceTitle(source)}`,
    );
    await this.toggleActivityCapability(`mammotion_command_${command}_${source}`);
    this.log("Mammotion command accepted by cloud", {
      command,
      source,
      timestamp,
    });
  }

  private async toggleActivityCapability(capability: string): Promise<void> {
    if (!this.hasCapability(capability)) {
      return;
    }

    const current = this.getCapabilityValue(capability) === true;
    await this.setCapabilitySafely(capability, !current);
  }

  private async setConnectionTimelineActivity(connected: boolean): Promise<void> {
    if (!this.hasCapability("mammotion_activity_connection")
      || this.getCapabilityValue("mammotion_activity_connection") === connected) {
      return;
    }

    await this.setCapabilitySafely("mammotion_activity_connection", connected);
  }

  private async setCapabilitySafely(capability: string, value: boolean | number | string): Promise<void> {
    if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) {
      return;
    }

    try {
      await this.setCapabilityValue(capability, value);
    } catch (error) {
      this.error(`Could not update Mammotion capability ${capability}`, error);
    }
  }

  private stopTelemetryMonitoring(): void {
    if (this.telemetryStaleTimer) {
      clearTimeout(this.telemetryStaleTimer);
      this.telemetryStaleTimer = undefined;
    }

    if (this.telemetryRefreshTimer) {
      clearInterval(this.telemetryRefreshTimer);
      this.telemetryRefreshTimer = undefined;
    }

    this.unsubscribeTelemetry?.();
    this.unsubscribeTelemetry = undefined;
  }

  private async refreshCommandStore(): Promise<void> {
    const store = this.getStore() as MowerStore;
    const data = this.getData();
    const knownIds = new Set([
      getStoreString(store.deviceId),
      getStoreString(store.deviceName),
      getStoreString(store.iotId),
      getStoreString(data.id),
    ].filter(Boolean));

    if (!knownIds.size) {
      return;
    }

    try {
      const devices = await this.getMammotionClient().getDevices();
      const match = devices.find((device) => knownIds.has(device.iotId)
        || knownIds.has(device.deviceName)
        || ("deviceId" in device && knownIds.has(device.deviceId)));

      if (!match) {
        return;
      }

      if ("deviceId" in match && match.deviceId) {
        await this.setStoreValue("deviceId", match.deviceId);
      }
      if (match.deviceName) {
        await this.setStoreValue("deviceName", match.deviceName);
      }
      if (match.iotId) {
        await this.setStoreValue("iotId", match.iotId);
      }
      if ("productKey" in match && match.productKey) {
        await this.setStoreValue("productKey", match.productKey);
      }
      if ("deviceType" in match && match.deviceType) {
        await this.setStoreValue("deviceType", match.deviceType);
      }
      if ("productSeries" in match && match.productSeries) {
        await this.setStoreValue("productSeries", match.productSeries);
      }
      if ("series" in match && match.series) {
        await this.setStoreValue("series", match.series);
      }
      if (match.deviceName) {
        await this.setStoreValue("recordDeviceName", match.deviceName);
      }

      this.log("Mammotion mower metadata refreshed", {
        deviceId: "deviceId" in match ? match.deviceId || "<missing>" : "<missing>",
        deviceName: match.deviceName || "<missing>",
        deviceType: "deviceType" in match ? match.deviceType || "<missing>" : "<missing>",
        iotId: match.iotId || "<missing>",
        productKey: "productKey" in match ? match.productKey || "<missing>" : "<missing>",
        productSeries: "productSeries" in match ? match.productSeries || "<missing>" : "<missing>",
        series: "series" in match ? match.series || "<missing>" : "<missing>",
      });
    } catch (error) {
      this.error("Could not refresh Mammotion mower command metadata", error);
    }
  }

  private async ensureCommandCapabilities(): Promise<void> {
    for (const capability of COMMAND_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  private async ensureStatusCapabilities(): Promise<void> {
    for (const capability of STATUS_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  private async initializeStatusCapabilities(): Promise<void> {
    const defaults: Record<string, boolean | number | string> = {
      mammotion_charge_status: "unknown",
      mammotion_connection: "waiting",
      mammotion_current_zone: "—",
      mammotion_last_update: "Waiting for mower status",
      mammotion_progress: 0,
      mammotion_state: "unknown",
    };

    for (const [capability, value] of Object.entries(defaults)) {
      if (this.getCapabilityValue(capability) === null) {
        await this.setCapabilitySafely(capability, value);
      }
    }
  }

  private async removeLegacyCapabilities(): Promise<void> {
    for (const capability of LEGACY_CAPABILITIES) {
      if (this.hasCapability(capability)) {
        await this.removeCapability(capability);
      }
    }
  }

  private registerCommandCapabilityListeners(): void {
    this.registerCapabilityListener("mammotion_pause", () => this.pauseMowing("homey_control"));
    this.registerCapabilityListener("mammotion_resume", () => this.resumeMowing("homey_control"));
    this.registerCapabilityListener("mammotion_cancel", () => this.cancelMowing("homey_control"));
    this.registerCapabilityListener("mammotion_dock", () => this.returnToDock("homey_control"));
  }
}

export = MowerDevice;
