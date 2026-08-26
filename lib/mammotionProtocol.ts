export type MammotionCommandTarget = {
  deviceName?: string;
  deviceType?: number | string | null;
  iotId: string;
  productKey?: string;
  productSeries?: string;
  recordDeviceName?: string;
  series?: string;
};

export type MammotionStartMowingSettings = {
  areaHashes: bigint[];
  bladeHeight: number;
  borderLaps: number;
  channelMode: number;
  channelWidth: number;
  cuttingPathAngle: number;
  cuttingPathAngleMode: number;
  mowOrder: number;
  obstacleDetection: number;
  obstacleLaps: number;
  speed: number;
  startProgress: number;
};

export type MammotionArea = {
  hash: string;
  name: string;
};

export type MammotionAreaHashInfo = {
  hash: string;
  name?: string;
  type: number;
};

/** Partial status update decoded from a Mammotion protobuf report. */
export type MammotionTelemetry = {
  batteryCycles?: number;
  batteryPercent?: number;
  bladeHeightMm?: number;
  bladeWorkTimeSeconds?: number;
  chargeState?: number;
  cutterMode?: number;
  cutterRpm?: number;
  errorCode?: number;
  firmwareVersion?: string;
  iotConnectionStatus?: number;
  lockState?: number;
  mowingProgressPercent?: number;
  online: boolean;
  pathHash?: string;
  receivedAt: number;
  rtkPositionLevel?: number;
  rtkSatellites?: number;
  rtkStatus?: number;
  selfCheckStatus?: number;
  stateCode?: number;
  totalMileageMeters?: number;
  totalWorkTimeSeconds?: number;
  wifiAvailable?: boolean;
  wifiConnectionStatus?: number;
  wifiRssi?: number;
  zoneHash?: string;
};

export const MammotionTaskAction = {
  Start: 1,
  Pause: 2,
  Resume: 3,
  Cancel: 4,
  ReturnToDock: 5,
} as const;

export type MammotionTaskAction = typeof MammotionTaskAction[keyof typeof MammotionTaskAction];

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const MSG_CMD_TYPE_NAV = 240;
const MSG_ATTR_REQ = 1;
const DEV_MAINCTL = 1;
const DEV_MOBILEAPP = 7;
const DEV_NAVIGATION = 17;

const LUBA_PRO_PRODUCT_KEYS = new Set([
  "a1mb8v6tnAa",
  "a1pHsTqyoPR",
]);

let sequence = 0;

function nextSequence(): number {
  sequence = (sequence + 1) & 0xff;

  return sequence;
}

function encodeVarint(input: number | bigint): Buffer {
  let value = typeof input === "bigint" ? input : BigInt(input);

  if (value < 0n) {
    throw new Error("Negative protobuf varints are not supported");
  }

  const bytes: number[] = [];

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
    encodeFieldKey(fieldNumber, WIRE_VARINT),
    encodeVarint(value),
  ]);
}

function fieldBytes(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeFieldKey(fieldNumber, WIRE_LENGTH_DELIMITED),
    encodeVarint(value.length),
    value,
  ]);
}

function fieldString(fieldNumber: number, value: string): Buffer {
  return fieldBytes(fieldNumber, Buffer.from(value, "utf8"));
}

function concatFields(fields: Buffer[]): Buffer {
  return Buffer.concat(fields.filter((field) => field.length > 0));
}

function getNavigationReceiver(productKey?: string): number {
  return productKey && LUBA_PRO_PRODUCT_KEYS.has(productKey)
    ? DEV_NAVIGATION
    : DEV_MAINCTL;
}

function createNavigationEnvelope({
  nav,
  productKey,
  receiverDevice,
  userAccount,
}: {
  nav: Buffer;
  productKey?: string;
  receiverDevice?: number;
  userAccount?: number;
}): Buffer {
  return concatFields([
    fieldVarint(1, MSG_CMD_TYPE_NAV),
    fieldVarint(2, DEV_MOBILEAPP),
    fieldVarint(3, receiverDevice ?? getNavigationReceiver(productKey)),
    fieldVarint(4, MSG_ATTR_REQ),
    fieldVarint(5, nextSequence()),
    fieldVarint(6, 1),
    fieldVarint(7, getUserAccountSubtype(userAccount)),
    fieldBytes(11, nav),
    fieldVarint(15, BigInt(Date.now())),
  ]);
}

function getUserAccountSubtype(userAccount?: number): number {
  if (!Number.isFinite(userAccount)) {
    return 0;
  }

  return Math.max(0, Math.trunc(userAccount as number));
}

export function createExecuteScheduleMessage({
  planId,
  productKey,
  userAccount,
}: {
  planId: string;
  productKey?: string;
  userAccount?: number;
}): Buffer {
  const planTaskExecute = concatFields([
    fieldVarint(1, 1),
    fieldString(2, planId),
  ]);
  const nav = fieldBytes(53, planTaskExecute);

  return createNavigationEnvelope({ nav, productKey, userAccount });
}
