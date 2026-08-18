import fs from "fs";
import Module from "module";
import path from "path";

import {
  type MammotionArea,
  type MammotionAreaHashInfo,
  type MammotionTelemetry,
  MammotionTaskAction,
  type MammotionCommandTarget,
  type MammotionStartMowingSettings,
  type MammotionTaskAction as MammotionTaskActionValue,
} from "./mammotionProtocol";

type DNAngelXSession = {
  userAccount: string;
};

type DNAngelXContext = {
  deviceId: string;
  deviceName: string;
  deviceType?: number | null;
  iotId: string;
  key: string;
  productKey: string;
  productSeries?: string;
  recordDeviceName: string;
  series?: string;
};

type DNAngelXRouteSettings = {
  areaHashes: bigint[];
  borderMode: number;
  channelMode: number;
  channelWidthCm: number;
  collectGrassFrequency: number;
  cutHeightMm: number;
  isDump: boolean;
  isEdge: boolean;
  isMow: boolean;
  jobId: number;
  jobMode: number;
  jobVersion: number;
  mowingLaps: number;
  mowSpeedMs: number;
  obstacleLaps: number;
  rideBoundaryDistance: number;
  startProgress: number;
  towardDeg: number;
  towardIncludedAngleDeg: number;
  towardMode: number;
  ultraWave: number;
};

type DNAngelXAdapterMethods = {
  buildAreaNameListContent(
    session: DNAngelXSession,
    context: DNAngelXContext,
    subCommand: number,
    receiverDeviceOverride?: number,
  ): string;
  buildNavGetCommDataContent(session: DNAngelXSession, context: DNAngelXContext, hash: bigint): string;
  buildRequestIotSyncContent(session: DNAngelXSession, stop?: boolean): string;
  buildRoutePlanningContent(
    session: DNAngelXSession,
    context: DNAngelXContext,
    settings: DNAngelXRouteSettings,
    mode: "generate" | "modify" | "query",
  ): string;
  buildSetBladeHeightContent(session: DNAngelXSession, cutHeightMm: number): string;
  buildTaskControlContent(
    session: DNAngelXSession,
    context: DNAngelXContext,
    command: "start" | "pause" | "resume" | "stop" | "dock" | "cancelJob" | "cancelDock",
  ): string;
  collectProtoFieldMapsFromBuffer(buffer: Buffer, maxDepth?: number): Array<Map<number, Array<Buffer | bigint>>>;
  decodeProtoFields(buffer: Buffer): Map<number, Array<Buffer | bigint>>;
  hashFrameAccumulator: Map<string, { frames: Map<number, bigint[]>; totalFrame: number }>;
  getReceiverDevice(context: DNAngelXContext): number;
  isYukaDevice(context: DNAngelXContext): boolean;
  seq: number;
  tryParseAreaHashNames(content: string): Array<{ hash: bigint; name: string }> | null;
  tryParseNavGetHashListAck(content: string, deviceKey: string): bigint[] | null;
};

let adapterClass: { prototype: DNAngelXAdapterMethods } | undefined;

function loadAdapterClass(): { prototype: DNAngelXAdapterMethods } {
  if (adapterClass) {
    return adapterClass;
  }

  const mainPath = require.resolve("iobroker.mammotion/build/main.js");
  const originalSource = fs.readFileSync(mainPath, "utf8");
  const patchedSource = originalSource.replace(
    "module.exports = (options) => new Mammotion(options);",
    "module.exports = Mammotion;",
  );

  if (patchedSource === originalSource) {
    throw new Error("Could not expose DNAngelX Mammotion adapter class");
  }

  const moduleInstance = new Module(`${mainPath}#homey-methods`, module.parent || module);

  moduleInstance.filename = mainPath;
  moduleInstance.paths = (Module as typeof Module & { _nodeModulePaths(from: string): string[] })
    ._nodeModulePaths(path.dirname(mainPath));
  moduleInstance.require = ((id: string) => {
    if (id === "@iobroker/adapter-core") {
      return {
        Adapter: class {},
      };
    }

    return Module.prototype.require.call(moduleInstance, id);
  }) as NodeJS.Require;
  (moduleInstance as NodeJS.Module & { _compile(source: string, filename: string): void })
    ._compile(patchedSource, mainPath);

  adapterClass = moduleInstance.exports as { prototype: DNAngelXAdapterMethods };

  return adapterClass;
}

function createAdapterMethodObject(): DNAngelXAdapterMethods {
  const klass = loadAdapterClass();
  const methods = Object.create(klass.prototype) as DNAngelXAdapterMethods;
  const getUpstreamReceiverDevice = methods.getReceiverDevice.bind(methods);

  methods.hashFrameAccumulator = new Map();
  methods.seq = 0;
  methods.getReceiverDevice = (context: DNAngelXContext): number => {
    const upstreamReceiver = getUpstreamReceiverDevice(context);

    // ioBroker.mammotion 0.0.7 only routes Luba VP/Pro product keys to the
    // navigation controller. PyMammotion routes every Luba 2 (Luba-VS) there.
    // A Luba 2 command sent to DEV_MAINCTL is accepted by the cloud RPC bridge,
    // but the mower does not execute it.
    if (isLuba2Context(context)) {
      return 17;
    }

    return upstreamReceiver;
  };

  return methods;
}

function isLuba2Context(context: DNAngelXContext): boolean {
  const deviceType = typeof context.deviceType === "number"
    ? context.deviceType
    : Number(context.deviceType);
  const hint = [
    context.deviceName,
    context.recordDeviceName,
    context.productSeries,
    context.series,
  ].filter(Boolean).join(" ").toLowerCase();

  return deviceType === 2
    || hint.includes("luba-vs")
    || /\bluba[\s_-]*2\b/.test(hint);
}

function toSession(userAccount: number): DNAngelXSession {
  return {
    userAccount: Number.isFinite(userAccount) ? String(Math.trunc(userAccount)) : "0",
  };
}

function toContext(target: MammotionCommandTarget): DNAngelXContext {
  const deviceName = target.deviceName || target.recordDeviceName || target.iotId;
  const recordDeviceName = target.recordDeviceName || target.deviceName || target.iotId;
  const parsedDeviceType = typeof target.deviceType === "string"
    ? Number(target.deviceType)
    : target.deviceType;

  return {
    deviceId: target.iotId,
    deviceName,
    deviceType: Number.isFinite(parsedDeviceType) ? parsedDeviceType as number : null,
    iotId: target.iotId,
    key: target.iotId,
    productKey: target.productKey || "",
    productSeries: target.productSeries || "",
    recordDeviceName,
    series: target.series || "",
  };
}

export function toRouteBorderMode(mowOrder: number): number {
  // Mammotion encodes the path order as 0 = perimeter first, 1 = grid first.
  return mowOrder === 1 ? 1 : 0;
}

function toRouteSettings(settings: MammotionStartMowingSettings): DNAngelXRouteSettings {
  return {
    areaHashes: settings.areaHashes,
    borderMode: toRouteBorderMode(settings.mowOrder),
    channelMode: settings.channelMode,
    channelWidthCm: settings.channelWidth,
    collectGrassFrequency: 10,
    cutHeightMm: settings.bladeHeight,
    isDump: true,
    isEdge: false,
    isMow: true,
    jobId: Date.now(),
    jobMode: 4,
    jobVersion: 1,
    mowingLaps: settings.borderLaps,
    mowSpeedMs: settings.speed,
    obstacleLaps: settings.obstacleLaps,
    rideBoundaryDistance: 0,
    startProgress: settings.startProgress,
    towardDeg: settings.cuttingPathAngle,
    towardIncludedAngleDeg: 0,
    towardMode: settings.cuttingPathAngleMode,
    ultraWave: settings.obstacleDetection,
  };
}

function taskActionToDNAngelXCommand(
  action: MammotionTaskActionValue,
): "start" | "pause" | "resume" | "stop" | "dock" | "cancelJob" {
  switch (action) {
    case MammotionTaskAction.Start:
      return "start";
    case MammotionTaskAction.Pause:
      return "pause";
    case MammotionTaskAction.Resume:
      return "resume";
    case MammotionTaskAction.Cancel:
      return "stop";
    case MammotionTaskAction.ReturnToDock:
      return "dock";
    default:
      return "start";
  }
}

function base64ToBuffer(content: string): Buffer {
  return Buffer.from(content, "base64");
}

function encodeVarint(input: number | bigint): Buffer {
  let value = typeof input === "bigint" ? input : BigInt(input);
  const bytes: number[] = [];

  if (value < 0n) {
    throw new Error("Negative protobuf varints are not supported");
  }

  while (value > 0x7fn) {
    bytes.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }

  bytes.push(Number(value));

  return Buffer.from(bytes);
}

function encodeFieldKey(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function fieldVarint(fieldNumber: number, value: number | bigint): Buffer {
  return Buffer.concat([
    encodeFieldKey(fieldNumber, 0),
    encodeVarint(value),
  ]);
}

function fieldBytes(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeFieldKey(fieldNumber, 2),
    encodeVarint(value.length),
    value,
  ]);
}

function concatFields(fields: Buffer[]): Buffer {
  return Buffer.concat(fields.filter((field) => field.length > 0));
}

function decodeVarintAt(buffer: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let position = offset;

  while (position < buffer.length) {
    const byte = buffer[position];

    position += 1;
    result |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      break;
    }

    shift += 7n;
  }

  return [result, position];
}

function decodePackedVarints(buffer: Buffer): bigint[] {
  const values: bigint[] = [];
  let position = 0;

  while (position < buffer.length) {
    const [value, nextPosition] = decodeVarintAt(buffer, position);

    if (nextPosition <= position) {
      break;
    }

    values.push(value);
    position = nextPosition;
  }

  return values;
}

function sortAreas(areas: MammotionArea[]): MammotionArea[] {
  return areas.sort((first, second) => first.name.localeCompare(second.name, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

function buildAreaHashInfoCommandBuffer({
  hash,
  receiverDevice,
  sequence,
  userAccount,
}: {
  hash: bigint;
  receiverDevice: number;
  sequence: number;
  userAccount: number;
}): Buffer {
  const commDataPayload = concatFields([
    fieldVarint(1, 1),
    fieldVarint(2, 1),
    fieldVarint(3, 8),
    fieldVarint(5, hash),
  ]);
  const navPayload = fieldBytes(32, commDataPayload);

  return concatFields([
    fieldVarint(1, 240),
    fieldVarint(2, 7),
    fieldVarint(3, receiverDevice),
    fieldVarint(4, 1),
    fieldVarint(5, sequence),
    fieldVarint(6, 1),
    fieldVarint(7, Number.isFinite(userAccount) ? Math.trunc(userAccount) : 0),
    fieldBytes(11, navPayload),
    fieldVarint(15, BigInt(Date.now())),
  ]);
}

function buildAreaNamesRequestCommandBuffer({
  deviceId,
  receiverDevice,
  sequence,
  userAccount,
}: {
  deviceId: string;
  receiverDevice: number;
  sequence: number;
  userAccount: number;
}): Buffer {
  // Current Luba 2 firmware requests the complete area-name manifest through
  // MctlNav.toapp_map_name_msg (field 58, rw=0). The mower replies through
  // MctlNav.toapp_all_hash_name (field 61).
  const mapNamePayload = concatFields([
    fieldVarint(1, 0),
    fieldVarint(2, 0),
    fieldVarint(4, 0),
    fieldBytes(5, Buffer.from(deviceId, "utf8")),
  ]);
  const navPayload = fieldBytes(58, mapNamePayload);

  return concatFields([
    fieldVarint(1, 240),
    fieldVarint(2, 7),
    fieldVarint(3, receiverDevice),
    fieldVarint(4, 1),
    fieldVarint(5, sequence),
    fieldVarint(6, 1),
    fieldVarint(7, Number.isFinite(userAccount) ? Math.trunc(userAccount) : 0),
    fieldBytes(11, navPayload),
    fieldVarint(15, BigInt(Date.now())),
  ]);
}

export default class DNAngelXMammotionMethods {
  private readonly methods = createAdapterMethodObject();

  getAreaReceiverCandidates(target: MammotionCommandTarget): number[] {
    const context = toContext(target);
    const receivers = new Set<number>([this.methods.getReceiverDevice(context)]);

    if (this.methods.isYukaDevice(context)) {
      receivers.add(17);
      receivers.add(1);
    }

    return [...receivers];
  }

  parseAreaHashInfos(content: string): MammotionAreaHashInfo[] {
    if (!content || content === "ok") {
      return [];
    }

    const infos = new Map<string, MammotionAreaHashInfo>();
    let root: Buffer;

    try {
      root = Buffer.from(content, "base64");
    } catch {
      return [];
    }

    for (const fields of this.methods.collectProtoFieldMapsFromBuffer(root)) {
      for (const ack of fields.get(33) || []) {
        if (!(ack instanceof Buffer)) {
          continue;
        }

        const ackFields = this.methods.decodeProtoFields(ack);
        const hash = ackFields.get(6)?.[0];

        if (typeof hash !== "bigint") {
          continue;
        }

        const type = Number(ackFields.get(5)?.[0] ?? 0n);
        const nameTime = ackFields.get(15)?.[0];
        let name: string | undefined;

        if (nameTime instanceof Buffer) {
          const nameTimeFields = this.methods.decodeProtoFields(nameTime);
          const nameBuffer = nameTimeFields.get(1)?.[0];

          if (nameBuffer instanceof Buffer) {
            const parsedName = nameBuffer.toString("utf8").trim();

            if (parsedName) {
              name = parsedName;
            }
          }
        }

        infos.set(hash.toString(), {
          hash: hash.toString(),
          name,
          type,
        });
      }
    }

    return [...infos.values()];
  }

  /**
   * Decode the status messages emitted by current Luba/Yuka firmware.
   *
   * This intentionally walks the known protobuf path (LubaMsg.sys) instead of
   * recursively guessing fields. The same field numbers occur in map and RPC
   * acknowledgements and interpreting those as battery/state would corrupt the
   * Homey device status.
   */
  parseTelemetry(content: string): MammotionTelemetry | null {
    if (!content || content === "ok") {
      return null;
    }

    let root: Buffer;

    try {
      root = Buffer.from(content, "base64");
    } catch {
      return null;
    }

    const rootFields = this.methods.decodeProtoFields(root);
    const sysBuffers = this.readBufferFields(rootFields, 10);

    if (!sysBuffers.length) {
      return null;
    }

    const telemetry: MammotionTelemetry = {
      online: true,
      receivedAt: Date.now(),
    };

    for (const sysBuffer of sysBuffers) {
      const sysFields = this.methods.decodeProtoFields(sysBuffer);

      for (const batteryBuffer of this.readBufferFields(sysFields, 1)) {
        this.assignNumber(telemetry, "batteryPercent", this.readSignedInt32(
          this.methods.decodeProtoFields(batteryBuffer),
          1,
        ));
      }

      for (const workStateBuffer of this.readBufferFields(sysFields, 2)) {
        const workState = this.methods.decodeProtoFields(workStateBuffer);
        this.assignNumber(telemetry, "stateCode", this.readSignedInt32(workState, 1));
        this.assignNumber(telemetry, "chargeState", this.readSignedInt32(workState, 2));
        this.assignHash(telemetry, "zoneHash", this.readBigInt(workState, 3));
        this.assignHash(telemetry, "pathHash", this.readBigInt(workState, 4));
      }

      for (const errorBuffer of this.readBufferFields(sysFields, 7)) {
        this.assignNumber(telemetry, "errorCode", this.readSignedInt32(
          this.methods.decodeProtoFields(errorBuffer),
          1,
        ));
      }

      for (const mowInfoBuffer of this.readBufferFields(sysFields, 11)) {
        const mowInfo = this.methods.decodeProtoFields(mowInfoBuffer);
        this.assignNumber(telemetry, "stateCode", this.readSignedInt32(mowInfo, 1));
        this.assignNumber(telemetry, "batteryPercent", this.readSignedInt32(mowInfo, 2));
        this.assignNumber(telemetry, "bladeHeightMm", this.readSignedInt32(mowInfo, 3));
        this.assignNumber(telemetry, "rtkStatus", this.readSignedInt32(mowInfo, 4));
        this.assignNumber(telemetry, "rtkSatellites", this.readSignedInt32(mowInfo, 5));
      }

      for (const firmwareBuffer of this.readBufferFields(sysFields, 32)) {
        const firmwareFields = this.methods.decodeProtoFields(firmwareBuffer);
        const version = this.readString(firmwareFields, 2);

        if (version) {
          telemetry.firmwareVersion = version;
        }
      }

      for (const reportBuffer of this.readBufferFields(sysFields, 39)) {
        this.parseReportTelemetry(this.methods.decodeProtoFields(reportBuffer), telemetry);
      }

      for (const cutterBuffer of this.readBufferFields(sysFields, 67)) {
        this.parseCutterTelemetry(this.methods.decodeProtoFields(cutterBuffer), telemetry);
      }
    }

    return telemetry;
  }

  parseAreaHashes(content: string, deviceKey: string): string[] {
    if (!content || content === "ok") {
      return [];
    }

    try {
      const hashes = this.methods.tryParseNavGetHashListAck(content, deviceKey) || [];

      if (hashes.length) {
        return [...new Set(hashes.map((hash) => hash.toString()))];
      }
    } catch {
      // Fall through to the local parser. Some newer firmwares answer with
      // the same field-31 structure but a different sub_cmd than ioBroker
      // currently accepts.
    }

    return this.parseAreaHashesFromField31(content, deviceKey);
  }

  parseAreaNames(content: string): MammotionArea[] {
    if (!content || content === "ok") {
      return [];
    }

    try {
      const parsedAreas = this.methods.tryParseAreaHashNames(content) || [];
      const areasByHash = new Map<string, MammotionArea>();

      for (const area of parsedAreas) {
        const hash = area.hash.toString();
        const name = area.name.trim();

        if (hash && name) {
          areasByHash.set(hash, { hash, name });
        }
      }

      return sortAreas([...areasByHash.values()]);
    } catch {
      return [];
    }
  }

  summarizeProtoFields(content: string): string[] {
    if (!content || content === "ok") {
      return [];
    }

    let root: Buffer;

    try {
      root = Buffer.from(content, "base64");
    } catch {
      return [];
    }

    const counts = new Map<number, number>();

    for (const fields of this.methods.collectProtoFieldMapsFromBuffer(root)) {
      for (const [fieldNumber, values] of fields) {
        counts.set(fieldNumber, (counts.get(fieldNumber) || 0) + values.length);
      }
    }

    return [...counts.entries()]
      .sort((first, second) => first[0] - second[0])
      .map(([fieldNumber, count]) => `${fieldNumber}:${count}`);
  }

  summarizeAreaSignals(content: string): string[] {
    if (!content || content === "ok") {
      return [];
    }

    let root: Buffer;

    try {
      root = Buffer.from(content, "base64");
    } catch {
      return [];
    }

    const signals: string[] = [];

    for (const fields of this.methods.collectProtoFieldMapsFromBuffer(root)) {
      for (const ack of fields.get(31) || []) {
        if (!(ack instanceof Buffer)) {
          continue;
        }

        const ackFields = this.methods.decodeProtoFields(ack);
        const field13 = ackFields.get(13) || [];
        const field13Hashes = this.readHashListValues(field13);
        const fieldSummary = [...ackFields.entries()]
          .sort((first, second) => first[0] - second[0])
          .map(([fieldNumber, values]) => `${fieldNumber}:${values.length}`)
          .join(",");

        signals.push([
          "field31",
          `subCmd=${this.readNumberField(ackFields, 2, 0)}`,
          `total=${this.readNumberField(ackFields, 3, 1)}`,
          `frame=${this.readNumberField(ackFields, 4, 1)}`,
          `hashLen=${this.readNumberField(ackFields, 6, 0)}`,
          `field13=${field13.length}`,
          `hashes=${field13Hashes.length}`,
          `fields=${fieldSummary}`,
        ].join(" "));
      }

      const field33 = fields.get(33);

      if (field33?.length) {
        signals.push(`field33 count=${field33.length}`);
      }

      const field61 = fields.get(61);

      if (field61?.length) {
        signals.push(`field61 count=${field61.length}`);
      }
    }

    return [...new Set(signals)].slice(0, 12);
  }

  private parseReportTelemetry(
    report: Map<number, Array<Buffer | bigint>>,
    telemetry: MammotionTelemetry,
  ): void {
    for (const connectBuffer of this.readBufferFields(report, 1)) {
      const connect = this.methods.decodeProtoFields(connectBuffer);
      this.assignNumber(telemetry, "wifiRssi", this.readSignedInt32(connect, 3));
      this.assignNumber(telemetry, "iotConnectionStatus", this.readSignedInt32(connect, 11));
      this.assignNumber(telemetry, "wifiConnectionStatus", this.readSignedInt32(connect, 12));
      const wifiAvailable = this.readSignedInt32(connect, 13);

      if (wifiAvailable !== undefined) {
        telemetry.wifiAvailable = wifiAvailable !== 0;
      }
    }

    for (const deviceBuffer of this.readBufferFields(report, 2)) {
      const device = this.methods.decodeProtoFields(deviceBuffer);
      this.assignNumber(telemetry, "stateCode", this.readSignedInt32(device, 1));
      this.assignNumber(telemetry, "chargeState", this.readSignedInt32(device, 2));
      this.assignNumber(telemetry, "batteryPercent", this.readSignedInt32(device, 3));
      this.assignNumber(telemetry, "selfCheckStatus", this.readSignedInt32(device, 12));

      for (const lockBuffer of this.readBufferFields(device, 11)) {
        this.assignNumber(telemetry, "lockState", this.readSignedInt32(
          this.methods.decodeProtoFields(lockBuffer),
          1,
        ));
      }
    }

    for (const rtkBuffer of this.readBufferFields(report, 3)) {
      const rtk = this.methods.decodeProtoFields(rtkBuffer);
      this.assignNumber(telemetry, "rtkStatus", this.readSignedInt32(rtk, 1));
      this.assignNumber(telemetry, "rtkPositionLevel", this.readSignedInt32(rtk, 2));
      this.assignNumber(telemetry, "rtkSatellites", this.readSignedInt32(rtk, 3));
    }

    for (const locationBuffer of this.readBufferFields(report, 4)) {
      const location = this.methods.decodeProtoFields(locationBuffer);
      const zoneHash = this.readBigInt(location, 5);

      if (zoneHash !== undefined && zoneHash !== 0n) {
        telemetry.zoneHash = zoneHash.toString();
      }
    }

    for (const workBuffer of this.readBufferFields(report, 5)) {
      const work = this.methods.decodeProtoFields(workBuffer);
      const packedArea = this.readSignedInt32(work, 4);
      const directProgress = this.readSignedInt32(work, 3);
      const packedProgress = packedArea === undefined ? undefined : packedArea >>> 16;
      const progress = packedProgress !== undefined && packedProgress > 0 && packedProgress <= 100
        ? packedProgress
        : directProgress !== undefined && directProgress >= 0 && directProgress <= 100
          ? directProgress
          : undefined;

      this.assignNumber(telemetry, "mowingProgressPercent", progress);
      this.assignNumber(telemetry, "bladeHeightMm", this.readSignedInt32(work, 20));
      this.assignHash(telemetry, "pathHash", this.readBigInt(work, 2));
    }

    for (const firmwareBuffer of this.readBufferFields(report, 6)) {
      const firmware = this.readString(this.methods.decodeProtoFields(firmwareBuffer), 2);

      if (firmware) {
        telemetry.firmwareVersion = firmware;
      }
    }

    for (const maintainBuffer of this.readBufferFields(report, 7)) {
      const maintain = this.methods.decodeProtoFields(maintainBuffer);
      this.assignNumber(telemetry, "totalMileageMeters", this.readNumber(maintain, 1));
      this.assignNumber(telemetry, "totalWorkTimeSeconds", this.readSignedInt32(maintain, 2));
      this.assignNumber(telemetry, "batteryCycles", this.readSignedInt32(maintain, 3));

      for (const bladeBuffer of this.readBufferFields(maintain, 4)) {
        this.assignNumber(telemetry, "bladeWorkTimeSeconds", this.readSignedInt32(
          this.methods.decodeProtoFields(bladeBuffer),
          1,
        ));
      }
    }

    for (const cutterBuffer of this.readBufferFields(report, 12)) {
      this.parseCutterTelemetry(this.methods.decodeProtoFields(cutterBuffer), telemetry);
    }
  }

  private parseCutterTelemetry(
    cutter: Map<number, Array<Buffer | bigint>>,
    telemetry: MammotionTelemetry,
  ): void {
    this.assignNumber(telemetry, "cutterMode", this.readSignedInt32(cutter, 1));
    this.assignNumber(telemetry, "cutterRpm", this.readSignedInt32(cutter, 2));
  }

  private readBufferFields(
    fields: Map<number, Array<Buffer | bigint>>,
    fieldNumber: number,
  ): Buffer[] {
    return (fields.get(fieldNumber) || []).filter((value): value is Buffer => value instanceof Buffer);
  }

  private readBigInt(
    fields: Map<number, Array<Buffer | bigint>>,
    fieldNumber: number,
  ): bigint | undefined {
    const value = fields.get(fieldNumber)?.[0];

    return typeof value === "bigint" ? value : undefined;
  }

  private readNumber(
    fields: Map<number, Array<Buffer | bigint>>,
    fieldNumber: number,
  ): number | undefined {
    const value = this.readBigInt(fields, fieldNumber);

    return value === undefined ? undefined : Number(value);
  }

  private readSignedInt32(
    fields: Map<number, Array<Buffer | bigint>>,
    fieldNumber: number,
  ): number | undefined {
    const value = this.readBigInt(fields, fieldNumber);

    return value === undefined ? undefined : Number(BigInt.asIntN(32, value));
  }

  private readString(
    fields: Map<number, Array<Buffer | bigint>>,
    fieldNumber: number,
  ): string | undefined {
    const value = fields.get(fieldNumber)?.[0];

    if (!(value instanceof Buffer)) {
      return undefined;
    }

    const result = value.toString("utf8").trim();

    return result || undefined;
  }

  private assignNumber<Key extends keyof MammotionTelemetry>(
    telemetry: MammotionTelemetry,
    key: Key,
    value: number | undefined,
  ): void {
    if (value !== undefined && Number.isFinite(value)) {
      (telemetry as Record<Key, unknown>)[key] = value;
    }
  }

  private assignHash<Key extends "pathHash" | "zoneHash">(
    telemetry: MammotionTelemetry,
    key: Key,
    value: bigint | undefined,
  ): void {
    if (value !== undefined && value !== 0n) {
      telemetry[key] = value.toString();
    }
  }

  private parseAreaHashesFromField31(content: string, deviceKey: string): string[] {
    let root: Buffer;

    try {
      root = Buffer.from(content, "base64");
    } catch {
      return [];
    }

    for (const fields of this.methods.collectProtoFieldMapsFromBuffer(root)) {
      for (const ack of fields.get(31) || []) {
        if (!(ack instanceof Buffer)) {
          continue;
        }

        const ackFields = this.methods.decodeProtoFields(ack);
        // Proto3 omits scalar fields that contain their default value. Current
        // Luba 2 firmware therefore leaves subCmd out for the root-list command
        // (subCmd=0), while older firmware encoded it explicitly.
        const subCommand = this.readNumberField(ackFields, 2, 0);
        const totalFrame = this.readNumberField(ackFields, 3, 1);
        const currentFrame = this.readNumberField(ackFields, 4, 1);
        const hashLength = this.readNumberField(ackFields, 6, 0);
        const hashes = this.readHashListValues(ackFields.get(13) || []);
        const zoneHashes = hashLength > 0 && hashes.length > hashLength
          ? hashes.slice(0, hashLength)
          : hashes;

        if (!zoneHashes.length) {
          continue;
        }

        if (![0, 3].includes(subCommand)) {
          continue;
        }

        if (totalFrame <= 1) {
          return [...new Set(zoneHashes.map((hash) => hash.toString()))];
        }

        const accumulatorKey = `${deviceKey}:field31:${subCommand}`;
        let accumulator = this.methods.hashFrameAccumulator.get(accumulatorKey);

        if (!accumulator || accumulator.totalFrame !== totalFrame) {
          accumulator = {
            frames: new Map<number, bigint[]>(),
            totalFrame,
          };
          this.methods.hashFrameAccumulator.set(accumulatorKey, accumulator);
        }

        accumulator.frames.set(currentFrame, zoneHashes);

        if (accumulator.frames.size < totalFrame) {
          return [];
        }

        const allHashes: bigint[] = [];

        for (let frame = 1; frame <= totalFrame; frame += 1) {
          allHashes.push(...accumulator.frames.get(frame) || []);
        }

        this.methods.hashFrameAccumulator.delete(accumulatorKey);

        return [...new Set(allHashes.map((hash) => hash.toString()))];
      }
    }

    return [];
  }

  private readHashListValues(values: Array<Buffer | bigint>): bigint[] {
    const hashes: bigint[] = [];

    for (const value of values) {
      if (value instanceof Buffer) {
        hashes.push(...decodePackedVarints(value));
      } else if (typeof value === "bigint") {
        hashes.push(value);
      }
    }

    return hashes;
  }

  private readNumberField(
    fields: Map<number, Array<Buffer | bigint>>,
    fieldNumber: number,
    fallback: number,
  ): number {
    const value = fields.get(fieldNumber)?.[0];

    return typeof value === "bigint" ? Number(value) : fallback;
  }

  buildAreaHashInfoCommand({
    hash,
    receiverDevice,
    target,
    userAccount,
  }: {
    hash: bigint;
    receiverDevice?: number;
    target: MammotionCommandTarget;
    userAccount: number;
  }): Buffer {
    if (typeof receiverDevice === "number") {
      this.methods.seq = (this.methods.seq + 1) & 0xff;

      return buildAreaHashInfoCommandBuffer({
        hash,
        receiverDevice,
        sequence: this.methods.seq,
        userAccount,
      });
    }

    return base64ToBuffer(this.methods.buildNavGetCommDataContent(
      toSession(userAccount),
      toContext(target),
      hash,
    ));
  }

  buildAreaNamesRequestCommand({
    receiverDevice,
    target,
    userAccount,
  }: {
    receiverDevice: number;
    target: MammotionCommandTarget;
    userAccount: number;
  }): Buffer {
    this.methods.seq = (this.methods.seq + 1) & 0xff;

    return buildAreaNamesRequestCommandBuffer({
      deviceId: target.iotId,
      receiverDevice,
      sequence: this.methods.seq,
      userAccount,
    });
  }

  buildAreaNameListCommand({
    receiverDevice,
    subCommand,
    target,
    userAccount,
  }: {
    receiverDevice?: number;
    subCommand: number;
    target: MammotionCommandTarget;
    userAccount: number;
  }): Buffer {
    return base64ToBuffer(this.methods.buildAreaNameListContent(
      toSession(userAccount),
      toContext(target),
      subCommand,
      receiverDevice,
    ));
  }

  buildRequestIotSyncCommand({
    stop = false,
    userAccount,
  }: {
    stop?: boolean;
    userAccount: number;
  }): Buffer {
    return base64ToBuffer(this.methods.buildRequestIotSyncContent(
      toSession(userAccount),
      stop,
    ));
  }

  buildRoutePlanningCommand({
    settings,
    target,
    userAccount,
  }: {
    settings: MammotionStartMowingSettings;
    target: MammotionCommandTarget;
    userAccount: number;
  }): Buffer {
    return base64ToBuffer(this.methods.buildRoutePlanningContent(
      toSession(userAccount),
      toContext(target),
      toRouteSettings(settings),
      "generate",
    ));
  }

  buildSetBladeHeightCommand({
    bladeHeight,
    userAccount,
  }: {
    bladeHeight: number;
    userAccount: number;
  }): Buffer {
    return base64ToBuffer(this.methods.buildSetBladeHeightContent(
      toSession(userAccount),
      bladeHeight,
    ));
  }

  buildTaskControlCommand({
    action,
    target,
    userAccount,
  }: {
    action: MammotionTaskActionValue;
    target: MammotionCommandTarget;
    userAccount: number;
  }): Buffer {
    return base64ToBuffer(this.methods.buildTaskControlContent(
      toSession(userAccount),
      toContext(target),
      taskActionToDNAngelXCommand(action),
    ));
  }
}
