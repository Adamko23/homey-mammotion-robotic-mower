import Homey from "homey";
import { OAuth2Client, OAuth2Driver } from "homey-oauth2app";

import MammotionOAuth2Client from "../../lib/MammotionOAuth2Client";
import type { MammotionArea, MammotionStartMowingSettings } from "../../lib/mammotionProtocol";
import {
  type MammotionStartMowingFlowArgs,
  type MammotionStartMowingOptions,
  normalizeStartMowingSettings,
} from "../../lib/mammotionStartMowing";
import type { MammotionDeviceInfo, MammotionDeviceRecord, MammotionShareRecord } from "../../lib/mammotionTypes";

type PairListDevicesArgs = {
  oAuth2Client: OAuth2Client;
};

type MowerFlowDevice = {
  autocompleteArea(query: string): Promise<AreaAutocompleteResult[]>;
  cancelMowing(source?: "homey_control" | "homey_flow"): Promise<void>;
  pauseMowing(source?: "homey_control" | "homey_flow"): Promise<void>;
  refreshAreas(): Promise<MammotionArea[]>;
  resolveAreaSelection(input: string): Promise<bigint[]>;
  resumeMowing(source?: "homey_control" | "homey_flow"): Promise<void>;
  returnToDock(source?: "homey_control" | "homey_flow"): Promise<void>;
  runSchedule(planId: string, source?: "homey_control" | "homey_flow"): Promise<void>;
  startMowing(settings: MammotionStartMowingSettings, source?: "homey_control" | "homey_flow"): Promise<void>;
};

type AreaAutocompleteResult = {
  all?: boolean;
  description?: string;
  hash?: string;
  hashes?: string[];
  id: string;
  name: string;
};

type MowerFlowArgs = MammotionStartMowingFlowArgs & {
  area?: unknown;
  area_hashes?: unknown;
  area_selector?: unknown;
  device?: MowerFlowDevice;
  plan_id?: unknown;
};

type MammotionPairDevice = MammotionDeviceInfo | MammotionDeviceRecord | MammotionShareRecord;

function getDeviceIdentifier(device: MammotionPairDevice): string {
  const id = device.iotId || ("deviceId" in device ? device.deviceId : undefined) || device.deviceName;

  if (!id) {
    throw new Error("Mammotion device does not contain iotId, deviceId or deviceName");
  }

  return id;
}

function getDeviceName(device: MammotionPairDevice): string {
  return device.deviceName || ("deviceId" in device ? device.deviceId : undefined) || device.iotId || "Mammotion mower";
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isAreaHashList(value: string): boolean {
  const parts = value
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 && parts.every((part) => /^\d+$/.test(part));
}

function parseAreaHashes(value: unknown): bigint[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        return BigInt(part);
      } catch {
        throw new Error(`Invalid Mammotion area hash: ${part}`);
      }
    });
}

async function parseSelectedAreaHashes(args: MowerFlowArgs, device: MowerFlowDevice): Promise<bigint[]> {
  const selectedArea = args.area && typeof args.area === "object"
    ? args.area
    : args.area_selector && typeof args.area_selector === "object"
      ? args.area_selector
      : undefined;

  if (selectedArea) {
    const area = selectedArea as Partial<AreaAutocompleteResult>;
    const hashes = Array.isArray(area.hashes)
      ? area.hashes
      : typeof area.hash === "string"
        ? [area.hash]
        : typeof area.id === "string" && area.id !== "__all__"
          ? [area.id]
          : [];

    return hashes.map((hash) => {
      try {
        return BigInt(hash);
      } catch {
        throw new Error(`Invalid Mammotion area hash: ${hash}`);
      }
    });
  }

  const areaSelector = getString(args.area_selector) || getString(args.area_hashes);

  if (!areaSelector) {
    return [];
  }

  if (isAreaHashList(areaSelector)) {
    return parseAreaHashes(areaSelector);
  }

  return await device.resolveAreaSelection(areaSelector);
}

async function parseStartMowingSettings(
  args: MowerFlowArgs,
  device: MowerFlowDevice,
  options: MammotionStartMowingOptions = {},
): Promise<MammotionStartMowingSettings> {
  const areaHashes = await parseSelectedAreaHashes(args, device);

  if (!areaHashes.length) {
    throw new Error("Enter a Mammotion area name or paste one or more area hash IDs.");
  }

  return normalizeStartMowingSettings(args, areaHashes, options);
}

class MowerDriver extends OAuth2Driver {
  async onOAuth2Init(): Promise<void> {
    this.registerStartMowingAction("start_mowing", {
      defaultCuttingPathAngleMode: 0,
    });
    this.registerStartMowingAction("start_mowing_custom_angle", {
      cuttingPathAngleMode: 1,
    });

    this.registerMowerAction("refresh_zones", async (device) => {
      const areas = await device.refreshAreas();

      if (!areas.length) {
        throw new Error("No Mammotion mowing zones were received. Keep the mower online and retry.");
      }
    });

    this.registerMowerAction("pause_mowing", (device) => device.pauseMowing("homey_flow"));
    this.registerMowerAction("resume_mowing", (device) => device.resumeMowing("homey_flow"));
    this.registerMowerAction("cancel_mowing", (device) => device.cancelMowing("homey_flow"));
    this.registerMowerAction("return_to_dock", (device) => device.returnToDock("homey_flow"));

    this.homey.flow
      .getActionCard("run_schedule")
      .registerRunListener(async (args: MowerFlowArgs) => {
        const device = this.getFlowDevice(args);
        const planId = typeof args.plan_id === "string" ? args.plan_id : "";

        await device.runSchedule(planId, "homey_flow");

        return true;
      });

    this.log("Mammotion mower driver initialized");
  }

  async onPairListDevices({
    oAuth2Client,
  }: PairListDevicesArgs): Promise<Homey.Driver.PairDevice[]> {
    const devices = await (oAuth2Client as MammotionOAuth2Client).getDevices();

    return devices.map((device) => {
      const id = getDeviceIdentifier(device);

      return {
        name: getDeviceName(device),
        data: {
          id,
        },
        store: {
          deviceId: "deviceId" in device ? device.deviceId : undefined,
          deviceName: device.deviceName,
          deviceType: "deviceType" in device ? device.deviceType : undefined,
          iotId: device.iotId,
          productKey: "productKey" in device ? device.productKey : undefined,
          productSeries: "productSeries" in device ? device.productSeries : undefined,
          recordDeviceName: device.deviceName,
          series: "series" in device ? device.series : undefined,
        },
      };
    });
  }

  private registerMowerAction(
    id: string,
    listener: (device: MowerFlowDevice) => Promise<void>,
  ): void {
    this.homey.flow
      .getActionCard(id)
      .registerRunListener(async (args: MowerFlowArgs) => {
        await listener(this.getFlowDevice(args));

        return true;
      });
  }

  private registerStartMowingAction(id: string, options: MammotionStartMowingOptions): void {
    const card = this.homey.flow.getActionCard(id);

    card.registerArgumentAutocompleteListener(
      "area_selector",
      async (query: string, args: MowerFlowArgs) => await this.getFlowDevice(args).autocompleteArea(query),
    );

    card
      .registerRunListener(async (args: MowerFlowArgs) => {
        const device = this.getFlowDevice(args);

        await device.startMowing(await parseStartMowingSettings(args, device, options), "homey_flow");

        return true;
      });
  }

  private getFlowDevice(args: MowerFlowArgs): MowerFlowDevice {
    if (!args.device) {
      throw new Error("Mammotion flow action requires a mower device");
    }

    return args.device;
  }
}

export = MowerDriver;
