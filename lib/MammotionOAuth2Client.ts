import crypto from "crypto";
import Homey from "homey";
import { OAuth2Client, OAuth2Error, fetch } from "homey-oauth2app";
import mqtt, { type MqttClient } from "mqtt";

import DNAngelXMammotionMethods from "./DNAngelXMammotionMethods";
import MammotionOAuth2Token from "./MammotionOAuth2Token";
import {
  createExecuteScheduleMessage,
  MammotionTaskAction,
  type MammotionArea,
  type MammotionAreaHashInfo,
  type MammotionCommandTarget,
  type MammotionStartMowingSettings,
  type MammotionTaskAction as MammotionTaskActionValue,
  type MammotionTelemetry,
} from "./mammotionProtocol";
import {
  normalizeMqttPayloadData,
  parseMqttJsonTelemetryPayload,
} from "./mqttJsonTelemetry";
import type {
  MammotionDeviceInfo,
  MammotionDeviceRecord,
  MammotionDeviceRecords,
  MammotionJwtInfo,
  MammotionLoginData,
  MammotionResponse,
  MammotionShareRecord,
  MammotionShareRecords,
} from "./mammotionTypes";

const MAMMOTION_ID_DOMAIN = "https://id.mammotion.com";
const MAMMOTION_API_DOMAIN = "https://domestic.mammotion.com";
const LEGACY_TOKEN_PATH = "/oauth/token";
const TOKEN_PATH = "/oauth2/token";
const CLIENT_TYPE = "1";
const DEFAULT_APP_VERSION = "Homey,1.0.0";
const LEGACY_CLIENT_ID = "MADKALUBAS";
const LEGACY_CLIENT_SECRET = "GshzGRZJjuMUgd2sYHM7";
const MAMMOTION_DEVICE_OFFLINE_CODES = new Set([6205, 50103, 50104]);
const MAMMOTION_GATEWAY_TIMEOUT_CODE = 20056;
const MQTT_SYNC_INTERVAL_MS = 7_000;
const MQTT_RECONNECT_MIN_MS = 5_000;
const MQTT_RECONNECT_MAX_MS = 60_000;
const AREA_HASH_INFO_WAIT_MS = 8_000;
const AREA_MQTT_WAIT_MS = 20_000;
const AREA_NAME_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
const MOWING_COMMAND_ACK_WAIT_MS = 20_000;
const MAMMOTION_PUBLIC_KEY_PROD =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApLbeSgOvnwLTWbhaBQWNnnHMtSDAi" +
  "Gz0PEDbrtd1tLYoO0hukW5PSa6eHykch0Hc6etiqEx1xziS+vNf+iOXds70I4htaYit6yRToZlQ" +
  "Mim3DQxaZX68nIHIZogur0zGv9U8j01v5l/rHRxyDdlVx3+JkBg6Cqx4U1PXEnAJriqcyg0B8Gm" +
  "V8Lnmfng+aJLRyq5MkhstYCRv9AsmWu8NpZDJ1ffbkaS02Z9/wpubXTiFP6DG3V2mDw2VvzEcHi" +
  "cchw49oXmTi92yui+kBgSYlNygssOAyU6H071AfmRUeH3+TsV5u5rg+bCiKyHemVmcKdd3hhZB+" +
  "HjA8o3On6rg5wIDAQAB";

type TokenRequest = Record<string, string>;
type LegacyEncryptionKeys = {
  aesKey: string;
  iv: string;
};
type MammotionCommandData = {
  content?: unknown;
  output?: {
    content?: unknown;
  };
  result?: unknown;
};
type MammotionMqttConnection = {
  clientId: string;
  host: string;
  jwt: string;
  username: string;
};
type MammotionTopicTarget = {
  deviceName: string;
  iotId: string;
  productKey: string;
};
type MammotionMqttSubscribeTopic = {
  required: boolean;
  topic: string;
};
type AreaWaiter = {
  resolve(): void;
  timer: NodeJS.Timeout;
};
type AreaHashInfoWaiter = {
  resolve(info: MammotionAreaHashInfo | undefined): void;
  timer: NodeJS.Timeout;
};
type MowingCommandAck = "route_confirmed" | "task_started";
type MowingCommandAckWaiter = {
  resolve(confirmed: boolean): void;
  timer: NodeJS.Timeout;
};
type MammotionTelemetryListener = (telemetry: MammotionTelemetry) => void | Promise<void>;

function getOptionalEnv(name: string): string | undefined {
  const value = Homey.env[name]?.trim();

  return value || undefined;
}

function createOAuthSignature({
  clientId,
  clientSecret,
  request,
  timestamp,
}: {
  clientId: string;
  clientSecret: string;
  request: TokenRequest;
  timestamp: number;
}): string {
  const jsonData = JSON.stringify(request);
  const stringToSign = `${clientId}${timestamp}${TOKEN_PATH}${jsonData}`;
  const hashedSecret = crypto
    .createHash("md5")
    .update(clientSecret, "utf8")
    .digest("hex");

  return crypto
    .createHmac("sha256", hashedSecret)
    .update(stringToSign, "utf8")
    .digest("hex");
}

function createClientId(): string {
  const random = Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0");

  return `${Date.now()}_${random}_1`;
}

function randomString(length: number, alphabet: string): string {
  let result = "";

  for (let index = 0; index < length; index += 1) {
    result += alphabet[crypto.randomInt(alphabet.length)];
  }

  return result;
}

function createLegacyEncryptionKeys(): LegacyEncryptionKeys {
  return {
    aesKey: randomString(16, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    iv: randomString(16, "0123456789"),
  };
}

function encryptAesCbc(value: string, keys: LegacyEncryptionKeys): string {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(keys.aesKey, "utf8"),
    Buffer.from(keys.iv, "utf8"),
  );

  return Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function encryptLegacySessionKey(keys: LegacyEncryptionKeys): string {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(MAMMOTION_PUBLIC_KEY_PROD, "base64"),
    format: "der",
    type: "spki",
  });

  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(`${keys.aesKey},${keys.iv}`, "utf8"),
  ).toString("base64");
}

function decodeJwtInfo(accessToken: string | null | undefined): MammotionJwtInfo {
  if (!accessToken) {
    return {};
  }

  const [, payload] = accessToken.split(".");

  if (!payload) {
    return {};
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");

    return JSON.parse(decoded) as MammotionJwtInfo;
  } catch {
    return {};
  }
}

function getIotDomain(accessToken: string | null | undefined): string | undefined {
  const iot = decodeJwtInfo(accessToken).iot?.trim();

  if (!iot) {
    return undefined;
  }

  return (iot.includes("://") ? iot : `https://${iot}`).replace(/\/+$/, "");
}

function assertMammotionSuccess<T>(response: MammotionResponse<T>, fallbackMessage: string): T {
  if (response.code !== 0) {
    throw new OAuth2Error(response.msg || fallbackMessage, response.code);
  }

  if (typeof response.data === "undefined" || response.data === null) {
    throw new OAuth2Error(`${fallbackMessage}: empty response`);
  }

  return response.data;
}

function assertMammotionCommandSuccess(response: MammotionResponse<unknown>, fallbackMessage: string): void {
  if (response.code === 0 || response.code === 200) {
    return;
  }

  if (MAMMOTION_DEVICE_OFFLINE_CODES.has(response.code)) {
    throw new OAuth2Error(
      response.msg
        ? `${response.msg} (Mammotion offline code ${response.code})`
        : `Mammotion reports the mower is offline for cloud commands (${response.code})`,
      response.code,
    );
  }

  if (response.code === MAMMOTION_GATEWAY_TIMEOUT_CODE) {
    throw new OAuth2Error(
      response.msg
        ? `${response.msg} (Mammotion gateway code ${response.code})`
        : "Mammotion cloud gateway timed out while sending the command",
      response.code,
    );
  }

  throw new OAuth2Error(
    response.msg ? `${response.msg} (Mammotion code ${response.code})` : fallbackMessage,
    response.code,
  );
}

function extractMammotionCommandResult(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }

  if (!data || typeof data !== "object") {
    return undefined;
  }

  const commandData = data as MammotionCommandData;

  if (typeof commandData.result === "string" && commandData.result.trim()) {
    return commandData.result.trim();
  }

  if (typeof commandData.output?.content === "string" && commandData.output.content.trim()) {
    return commandData.output.content.trim();
  }

  if (typeof commandData.content === "string" && commandData.content.trim()) {
    return commandData.content.trim();
  }

  return undefined;
}

function getTaskActionName(action: MammotionTaskActionValue): string {
  switch (action) {
    case MammotionTaskAction.Start:
      return "start";
    case MammotionTaskAction.Pause:
      return "pause";
    case MammotionTaskAction.Resume:
      return "resume";
    case MammotionTaskAction.Cancel:
      return "cancel";
    case MammotionTaskAction.ReturnToDock:
      return "return_to_dock";
    default:
      return `unknown_${action}`;
  }
}

function createRequestId(): string {
  let requestId = "";

  for (let index = 0; index < 21; index += 1) {
    requestId += crypto.randomInt(10).toString();
  }

  return requestId;
}

function getDeviceMergeKeys(
  device: MammotionDeviceInfo | MammotionDeviceRecord | MammotionShareRecord,
): string[] {
  return [
    device.deviceName,
    device.iotId,
    "deviceId" in device ? device.deviceId : undefined,
  ].filter((value): value is string => Boolean(value));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getNestedValue(source: unknown, path: string[]): unknown {
  let current = source;

  for (const part of path) {
    const object = getObject(current);

    if (!object || !(part in object)) {
      return undefined;
    }

    current = object[part];
  }

  return current;
}

function extractMqttProtoContent(data: Record<string, unknown>): string | undefined {
  const params = getObject(data.params);
  const candidates = [
    getNestedValue(params, ["value", "content"]),
    getNestedValue(data, ["value", "content"]),
    params?.content,
    data.content,
    getNestedValue(params, ["items", "content", "value"]),
    getNestedValue(params, ["items", "content"]),
    getNestedValue(data, ["items", "content", "value"]),
    getNestedValue(data, ["items", "content"]),
  ];

  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
}

export default class MammotionOAuth2Client extends OAuth2Client {
  static API_URL = MAMMOTION_API_DOMAIN;
  static TOKEN = MammotionOAuth2Token;
  static TOKEN_URL = `${MAMMOTION_ID_DOMAIN}${TOKEN_PATH}`;
  static CLIENT_ID = "mammotion";
  static CLIENT_SECRET = "mammotion";
  static SCOPES: string[] = [];

  private readonly mammotionClientId = createClientId();
  private readonly areaRefreshByIotId = new Map<string, Promise<MammotionArea[]>>();
  private readonly areaHashClassificationByIotId = new Map<string, Promise<MammotionArea[]>>();
  private readonly areaHashInfoWaitersByKey = new Map<string, Set<AreaHashInfoWaiter>>();
  private readonly areaHashLogKeyByIotId = new Map<string, string>();
  private readonly areaNoZoneLogKeyByIotId = new Map<string, string>();
  private readonly areaRefreshActiveIotIds = new Set<string>();
  private readonly areaWaitersByIotId = new Map<string, Set<AreaWaiter>>();
  private readonly areasByIotId = new Map<string, Map<string, MammotionArea>>();
  private readonly dnaMethods = new DNAngelXMammotionMethods();
  private readonly mqttAreaWaitLogKeyByIotId = new Map<string, string>();
  private readonly mqttAreaHashClassificationKeyByIotId = new Map<string, string>();
  private readonly mqttSubscribedTopics = new Set<string>();
  private readonly mqttSyncByIotId = new Map<string, number>();
  private readonly mqttSyncDecodeLogKeyByIotId = new Map<string, string>();
  private readonly mqttTargetByTopicKey = new Map<string, MammotionTopicTarget>();
  private readonly mowingCommandAckWaitersByKey = new Map<string, Set<MowingCommandAckWaiter>>();
  private readonly telemetryListenersByIotId = new Map<string, Set<MammotionTelemetryListener>>();
  private mqttClient?: MqttClient;
  private mqttConnectPromise?: Promise<void>;
  private mqttReconnectAttempt = 0;
  private mqttReconnectTimer?: NodeJS.Timeout;

  async onGetTokenByCredentials({
    username,
    password,
  }: {
    username: string;
    password: string;
  }): Promise<MammotionOAuth2Token> {
    const signedOAuth2 = this.hasSignedOAuth2Client();
    const normalizedUsername = username.trim();

    this.log("Mammotion login started", {
      flow: signedOAuth2 ? "signed_oauth2" : "legacy_encrypted",
    });

    try {
      const token = signedOAuth2
        ? await this.requestSignedToken({
          request: {
            username: normalizedUsername,
            // Mammotion accepts the mobile-client password grant with the
            // password as plain UTF-8 query data. Some accounts return 40202
            // when the value is Base64 encoded.
            password,
            client_id: getOptionalEnv("MAMMOTION_OAUTH2_CLIENT_ID") as string,
            grant_type: "password",
            authType: "0",
          },
          signatureHeader: "Ma-Signature",
        })
        : await this.requestLegacyPasswordToken({ username: normalizedUsername, password });

      this.setToken({ token });
      this.log("Mammotion login succeeded");
      return token;
    } catch (error) {
      this.error("Mammotion login failed", error);
      throw error;
    }
  }

  async onRefreshToken(): Promise<MammotionOAuth2Token> {
    const currentToken = this.getToken() as MammotionOAuth2Token | null;

    if (!currentToken?.refresh_token) {
      throw new OAuth2Error("Mammotion token cannot be refreshed");
    }

    if (!this.hasSignedOAuth2Client()) {
      throw new OAuth2Error("Mammotion session expired. Please repair the device login.");
    }

    const token = await this.requestSignedToken({
      request: {
        client_id: getOptionalEnv("MAMMOTION_OAUTH2_CLIENT_ID") as string,
        grant_type: "refresh_token",
        refresh_token: currentToken.refresh_token,
      },
      signatureHeader: "Ma-Signature",
    });

    token.authorization_code ||= currentToken.authorization_code;
    token.userInformation ||= currentToken.userInformation;

    this.setToken({ token });
    this.save();

    return token;
  }

  async onGetOAuth2SessionInformation(): Promise<{ id: string; title: string }> {
    const token = this.getToken() as MammotionOAuth2Token | null;
    const user = token?.userInformation;
    const id = user?.userId || user?.userAccount || user?.email;

    if (!id) {
      throw new OAuth2Error("Mammotion login did not return a user id");
    }

    return {
      id: String(id),
      title: String(user?.email || user?.userAccount || id),
    };
  }

  async getDevices(): Promise<Array<MammotionDeviceInfo | MammotionDeviceRecord | MammotionShareRecord>> {
    const ownedDevices = await this.getOwnedDevices();
    const pagedDevices = await this.getPagedDevices();
    const sharedDevices = await this.getSharedDevices();
    const devicesById = new Map<
      string,
      MammotionDeviceInfo | MammotionDeviceRecord | MammotionShareRecord
    >();
    const aliases = new Map<string, string>();

    this.log("Mammotion discovery source counts", {
      owned: ownedDevices.length,
      paged: pagedDevices.length,
      shared: sharedDevices.length,
    });

    for (const device of [...ownedDevices, ...pagedDevices, ...sharedDevices]) {
      const keys = getDeviceMergeKeys(device);
      const id = keys.map((key) => aliases.get(key)).find(Boolean) || keys[0];

      if (id) {
        devicesById.set(id, {
          ...devicesById.get(id),
          ...device,
          iotId: devicesById.get(id)?.iotId || device.iotId,
        });

        for (const key of keys) {
          aliases.set(key, id);
        }
      }
    }

    const devices = [...devicesById.values()];

    this.rememberMqttTargets(devices);

    this.log("Mammotion devices discovered", devices.map((device) => {
      const productKey = "productKey" in device ? device.productKey : undefined;

      return {
        deviceId: "deviceId" in device ? device.deviceId : undefined,
        deviceName: device.deviceName || "<missing>",
        iotId: device.iotId || "<missing>",
        productKey: productKey || "<missing>",
        transport: "mammotion_rpc",
      };
    }));

    return devices;
  }

  async subscribeTelemetry({
    listener,
    target,
  }: {
    listener: MammotionTelemetryListener;
    target: MammotionCommandTarget;
  }): Promise<() => void> {
    const listeners = this.telemetryListenersByIotId.get(target.iotId) || new Set<MammotionTelemetryListener>();
    listeners.add(listener);
    this.telemetryListenersByIotId.set(target.iotId, listeners);

    try {
      await this.ensureMqttForTarget(target);
      await this.syncMqttTransport(target).catch((error: unknown) => {
        this.error("Mammotion initial telemetry sync failed", {
          iotId: target.iotId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      // Keep the listener registered: the MQTT reconnect loop can recover
      // without requiring an app restart after an internet/Wi-Fi outage.
      this.error("Mammotion telemetry subscription setup failed", {
        iotId: target.iotId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.scheduleMqttReconnect("telemetry subscription setup failed");
    }

    return () => {
      const current = this.telemetryListenersByIotId.get(target.iotId);
      current?.delete(listener);

      if (current && current.size === 0) {
        this.telemetryListenersByIotId.delete(target.iotId);
      }
    };
  }

  async refreshTelemetry(target: MammotionCommandTarget): Promise<void> {
    await this.ensureMqttForTarget(target);
    await this.syncMqttTransport(target);
  }

  async sendTaskControl({
    action,
    target,
  }: {
    action: MammotionTaskActionValue;
    target: MammotionCommandTarget;
  }): Promise<void> {
    await this.invokeDeviceCommand({
      payload: this.dnaMethods.buildTaskControlCommand({
        action,
        target,
        userAccount: this.getUserAccountSubtype(),
      }),
      target,
      type: `task_control:${getTaskActionName(action)}`,
    });
  }

  async startMowing({
    settings,
    target,
  }: {
    settings: MammotionStartMowingSettings;
    target: MammotionCommandTarget;
  }): Promise<void> {
    await this.invokeDeviceCommandAndWaitForMowingAck({
      acknowledgement: "route_confirmed",
      payload: this.dnaMethods.buildRoutePlanningCommand({
        settings,
        target,
        userAccount: this.getUserAccountSubtype(),
      }),
      target,
      type: "generate_route",
    });

    await this.invokeDeviceCommandAndWaitForMowingAck({
      acknowledgement: "task_started",
      payload: this.dnaMethods.buildTaskControlCommand({
        action: MammotionTaskAction.Start,
        target,
        userAccount: this.getUserAccountSubtype(),
      }),
      target,
      type: "start_task",
    });
  }

  async executeSchedule({
    planId,
    target,
  }: {
    planId: string;
    target: MammotionCommandTarget;
  }): Promise<void> {
    const trimmedPlanId = planId.trim();

    if (!trimmedPlanId) {
      throw new OAuth2Error("Mammotion schedule plan id is required");
    }

    await this.invokeDeviceCommand({
      payload: createExecuteScheduleMessage({
        planId: trimmedPlanId,
        productKey: target.productKey,
        userAccount: this.getUserAccountSubtype(),
      }),
      target,
      type: "execute_schedule",
    });
  }

  async refreshAreas({
    target,
  }: {
    target: MammotionCommandTarget;
  }): Promise<MammotionArea[]> {
    const currentRefresh = this.areaRefreshByIotId.get(target.iotId);

    if (currentRefresh) {
      return await currentRefresh;
    }

    const refresh = this.refreshAreasInternal({ target }).finally(() => {
      this.areaRefreshActiveIotIds.delete(target.iotId);
      this.areaRefreshByIotId.delete(target.iotId);
    });
    this.areaRefreshByIotId.set(target.iotId, refresh);

    return await refresh;
  }

  private async refreshAreasInternal({
    target,
  }: {
    target: MammotionCommandTarget;
  }): Promise<MammotionArea[]> {
    const areasByHash = new Map<string, MammotionArea>();
    const existingAreas = this.getCachedAreas(target.iotId);

    this.areaHashLogKeyByIotId.delete(target.iotId);
    this.areaNoZoneLogKeyByIotId.delete(target.iotId);
    this.areaRefreshActiveIotIds.add(target.iotId);
    this.mqttAreaHashClassificationKeyByIotId.delete(target.iotId);
    this.mqttAreaWaitLogKeyByIotId.delete(target.iotId);

    for (const area of existingAreas) {
      areasByHash.set(area.hash, area);
    }

    const receiverDevices = this.getAreaReceiverCandidates(target);

    this.log("Mammotion area receiver scan started", {
      deviceName: target.deviceName || "<missing>",
      iotId: target.iotId,
      productKey: target.productKey || "<missing>",
      receiverDevices,
    });

    let mqttAreaWaitAvailable = true;

    await this.ensureMqttForTarget(target).catch((error: unknown) => {
      mqttAreaWaitAvailable = false;
      this.error("Mammotion MQTT setup for areas failed", {
        deviceName: target.deviceName || "<missing>",
        iotId: target.iotId,
        message: error instanceof Error ? error.message : String(error),
        productKey: target.productKey || "<missing>",
      });
    });

    await this.requestAreaNameListOnce({
      areasByHash,
      receiverDevices,
      reason: "initial",
      target,
    });

    if (!areasByHash.size && mqttAreaWaitAvailable) {
      void this.retryAreaNameListWhileWaiting({
        areasByHash,
        receiverDevices,
        target,
      });
      await this.waitForMqttAreas(target.iotId, AREA_MQTT_WAIT_MS);

      // The first classified area resolves the MQTT waiter, but the root hash
      // list can contain more zones plus paths and obstacles. Keep the refresh
      // active until every hash from that list has been classified.
      const currentClassification = this.areaHashClassificationByIotId.get(target.iotId);

      if (currentClassification) {
        await currentClassification;
      }

      const mqttAreas = this.getCachedAreas(target.iotId);

      for (const area of mqttAreas) {
        areasByHash.set(area.hash, area);
      }
    } else if (!areasByHash.size) {
      this.log("Mammotion MQTT area wait skipped", {
        deviceName: target.deviceName || "<missing>",
        iotId: target.iotId,
        productKey: target.productKey || "<missing>",
        reason: "MQTT setup failed",
      });
    }

    const areas = [...areasByHash.values()].sort((first, second) => first.name.localeCompare(second.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }));

    this.log("Mammotion areas refreshed", {
      count: areas.length,
      deviceName: target.deviceName || "<missing>",
      iotId: target.iotId,
      productKey: target.productKey || "<missing>",
    });

    return areas;
  }

  private async requestAreaNameListOnce({
    areasByHash,
    receiverDevices,
    reason,
    target,
  }: {
    areasByHash: Map<string, MammotionArea>;
    receiverDevices: number[];
    reason: string;
    target: MammotionCommandTarget;
  }): Promise<void> {
    for (const receiverDevice of receiverDevices) {
      const type = reason === "initial"
        ? `area_names:receiver_${receiverDevice}`
        : `area_names:${reason}:receiver_${receiverDevice}`;
      const result = await this.invokeDeviceCommand({
        payload: this.dnaMethods.buildAreaNamesRequestCommand({
          receiverDevice,
          target,
          userAccount: this.getUserAccountSubtype(),
        }),
        target,
        type,
      });
      const parsedAreas = this.dnaMethods.parseAreaNames(result);

      for (const area of parsedAreas) {
        areasByHash.set(area.hash, area);
      }

      this.log("Mammotion current area-name response parsed", {
        namedAreas: parsedAreas.length,
        reason,
        receiverDevice,
        resultChars: result === "ok" ? 0 : result.length,
      });

      if (parsedAreas.length) {
        this.rememberAreasFromMap(target.iotId, areasByHash);
        return;
      }
    }

    areaRequests:
    for (const subCommand of [0]) {
      for (const receiverDevice of receiverDevices) {
        const areaCountBeforeCommand = areasByHash.size;
        const type = reason === "initial"
          ? `area_name_list:${subCommand}:receiver_${receiverDevice}`
          : `area_name_list:${reason}:${subCommand}:receiver_${receiverDevice}`;
        const result = await this.invokeDeviceCommand({
          payload: this.dnaMethods.buildAreaNameListCommand({
            receiverDevice,
            subCommand,
            target,
            userAccount: this.getUserAccountSubtype(),
          }),
          target,
          type,
        });
        const parsedAreas = this.dnaMethods.parseAreaNames(result);
        const parsedHashes = this.dnaMethods.parseAreaHashes(result, target.iotId);

        for (const area of parsedAreas) {
          areasByHash.set(area.hash, area);
        }

        if (parsedHashes.length) {
          const classifiedAreas = await this.classifyAreaHashes({
            hashes: parsedHashes,
            source: type,
            target,
          });

          for (const area of classifiedAreas) {
            areasByHash.set(area.hash, area);
          }
        }

        this.log("Mammotion area response parsed", {
          areaHashes: parsedHashes.length,
          namedAreas: parsedAreas.length,
          protoFields: parsedAreas.length || parsedHashes.length ? undefined : this.dnaMethods.summarizeProtoFields(result),
          reason,
          receiverDevice,
          resultChars: result === "ok" ? 0 : result.length,
          subCommand,
        });

        if (areasByHash.size > areaCountBeforeCommand) {
          this.rememberAreasFromMap(target.iotId, areasByHash);
          break areaRequests;
        }
      }
    }
  }

  private async retryAreaNameListWhileWaiting({
    areasByHash,
    receiverDevices,
    target,
  }: {
    areasByHash: Map<string, MammotionArea>;
    receiverDevices: number[];
    target: MammotionCommandTarget;
  }): Promise<void> {
    for (let attempt = 0; attempt < AREA_NAME_RETRY_DELAYS_MS.length; attempt += 1) {
      await wait(AREA_NAME_RETRY_DELAYS_MS[attempt]);

      if (!this.isCollectingAreaData(target.iotId) || this.getCachedAreas(target.iotId).length) {
        return;
      }

      this.log("Mammotion area request retry", {
        attempt: attempt + 1,
        deviceName: target.deviceName || "<missing>",
        iotId: target.iotId,
        productKey: target.productKey || "<missing>",
        receiverDevices,
      });

      await this.requestAreaNameListOnce({
        areasByHash,
        receiverDevices,
        reason: `retry_${attempt + 1}`,
        target,
      }).catch((error: unknown) => {
        this.error("Mammotion area request retry failed", {
          attempt: attempt + 1,
          deviceName: target.deviceName || "<missing>",
          iotId: target.iotId,
          message: error instanceof Error ? error.message : String(error),
          productKey: target.productKey || "<missing>",
        });
      });
    }
  }

  private rememberAreasFromMap(iotId: string, areasByHash: Map<string, MammotionArea>): void {
    if (!areasByHash.size) {
      return;
    }

    const cachedAreasByHash = this.areasByIotId.get(iotId) || new Map<string, MammotionArea>();

    for (const area of areasByHash.values()) {
      cachedAreasByHash.set(area.hash, area);
    }

    this.areasByIotId.set(iotId, cachedAreasByHash);
    this.resolveAreaWaiters(iotId);
  }

  private getAreaReceiverCandidates(target: MammotionCommandTarget): number[] {
    return this.dnaMethods.getAreaReceiverCandidates(target);
  }

  private getAreaHashInfoReceiverCandidates(target: MammotionCommandTarget): number[] {
    return this.getAreaReceiverCandidates(target);
  }

  private rememberMqttTargets(devices: Array<MammotionDeviceInfo | MammotionDeviceRecord | MammotionShareRecord>): void {
    for (const device of devices) {
      const productKey = "productKey" in device ? device.productKey : undefined;

      if (!device.iotId || !device.deviceName || !productKey) {
        continue;
      }

      this.mqttTargetByTopicKey.set(`${productKey}/${device.deviceName}`, {
        deviceName: device.deviceName,
        iotId: device.iotId,
        productKey,
      });
    }
  }

  private rememberMqttTarget(target: MammotionCommandTarget): MammotionTopicTarget | undefined {
    if (!target.productKey || !target.deviceName) {
      return undefined;
    }

    const mqttTarget = {
      deviceName: target.deviceName,
      iotId: target.iotId,
      productKey: target.productKey,
    };

    this.mqttTargetByTopicKey.set(`${mqttTarget.productKey}/${mqttTarget.deviceName}`, mqttTarget);

    return mqttTarget;
  }

  private async ensureMqttForTarget(target: MammotionCommandTarget): Promise<void> {
    const mqttTarget = this.rememberMqttTarget(target);

    if (!mqttTarget) {
      this.log("Mammotion MQTT area sync skipped: missing productKey or deviceName", {
        deviceName: target.deviceName || "<missing>",
        iotId: target.iotId,
        productKey: target.productKey || "<missing>",
      });
      return;
    }

    await this.ensureMqttConnected();
    await this.subscribeMqttTarget(mqttTarget);
  }

  private async ensureMqttConnected(): Promise<void> {
    if (this.mqttReconnectTimer) {
      clearTimeout(this.mqttReconnectTimer);
      this.mqttReconnectTimer = undefined;
    }

    if (this.mqttClient?.connected) {
      return;
    }

    if (this.mqttConnectPromise) {
      await this.mqttConnectPromise;
      return;
    }

    this.mqttConnectPromise = this.connectMqtt().finally(() => {
      this.mqttConnectPromise = undefined;
    });

    await this.mqttConnectPromise;
  }

  private async connectMqtt(): Promise<void> {
    const credentials = await this.getMqttCredentials();
    const brokerUrl = credentials.host.includes("://") ? credentials.host : `mqtts://${credentials.host}`;

    this.log("Mammotion MQTT credentials loaded", {
      clientId: credentials.clientId ? "<present>" : "<missing>",
      host: credentials.host || "<missing>",
      username: credentials.username ? "<present>" : "<missing>",
    });

    if (this.mqttClient) {
      this.mqttClient.removeAllListeners();
      this.mqttClient.end(true);
      this.mqttClient = undefined;
      this.mqttSubscribedTopics.clear();
    }

    const client = mqtt.connect(brokerUrl, {
      clean: true,
      clientId: credentials.clientId,
      connectTimeout: 15_000,
      password: credentials.jwt,
      protocolVersion: 4,
      // Refresh the short-lived broker credentials on every reconnect instead
      // of letting mqtt.js retry forever with an expired JWT.
      reconnectPeriod: 0,
      username: credentials.username,
    });
    this.mqttClient = client;

    client.on("message", (topic: string, payload: Buffer) => {
      this.handleMqttMessage(topic, payload);
    });
    client.on("connect", () => {
      this.mqttReconnectAttempt = 0;
      this.log("Mammotion MQTT connected", {
        knownTargets: this.mqttTargetByTopicKey.size,
      });

      this.mqttSubscribedTopics.clear();

      if (!this.mqttConnectPromise) {
        void this.subscribeKnownMqttTargets();
      }
    });
    client.on("error", (error: Error) => {
      this.error("Mammotion MQTT error", error.message);
    });
    client.on("close", () => {
      this.mqttSubscribedTopics.clear();
      this.log("Mammotion MQTT connection closed", {
        connected: client.connected,
      });
      this.scheduleMqttReconnect("connection closed");
    });
    client.on("offline", () => {
      this.log("Mammotion MQTT connection offline");
      this.scheduleMqttReconnect("connection offline");
    });
    client.on("disconnect", (packet) => {
      this.log("Mammotion MQTT disconnected by broker", {
        reasonCode: packet.reasonCode,
        reasonString: packet.properties?.reasonString?.toString() || "",
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Mammotion MQTT connect timeout"));
      }, 15_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        client.off("close", onClose);
        client.off("connect", onConnect);
        client.off("error", onError);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("Mammotion MQTT connection closed before connect completed"));
      };
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      client.once("close", onClose);
      client.once("connect", onConnect);
      client.once("error", onError);
    });
  }

  private scheduleMqttReconnect(reason: string): void {
    if (this.mqttClient?.connected || this.mqttReconnectTimer) {
      return;
    }

    const delay = Math.min(
      MQTT_RECONNECT_MAX_MS,
      MQTT_RECONNECT_MIN_MS * (2 ** Math.min(this.mqttReconnectAttempt, 4)),
    );
    this.mqttReconnectAttempt += 1;
    this.log("Mammotion MQTT reconnect scheduled", {
      attempt: this.mqttReconnectAttempt,
      delay,
      reason,
    });

    this.mqttReconnectTimer = setTimeout(() => {
      this.mqttReconnectTimer = undefined;

      if (this.mqttClient && !this.mqttClient.connected) {
        this.mqttClient.removeAllListeners();
        this.mqttClient.end(true);
        this.mqttClient = undefined;
        this.mqttSubscribedTopics.clear();
      }

      void this.ensureMqttConnected()
        .then(() => this.subscribeKnownMqttTargets())
        .catch((error: unknown) => {
          this.error("Mammotion MQTT reconnect failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          this.scheduleMqttReconnect("reconnect failed");
        });
    }, delay);
  }

  private async subscribeMqttTarget(target: MammotionTopicTarget): Promise<void> {
    const client = this.mqttClient;

    if (!client) {
      throw new Error("Mammotion MQTT client is not initialized");
    }

    const topics = this.getMqttSubscribeTopics(target);
    let subscribed = 0;
    let deferred = 0;

    for (const { required, topic } of topics) {
      if (this.mqttSubscribedTopics.has(topic)) {
        continue;
      }

      if (!client.connected) {
        deferred += 1;
        this.log("Mammotion MQTT subscription deferred: connection is closed", {
          deviceName: target.deviceName,
          iotId: target.iotId,
          productKey: target.productKey,
          topic,
        });
        break;
      }

      this.log("Mammotion MQTT subscribing", {
        deviceName: target.deviceName,
        iotId: target.iotId,
        productKey: target.productKey,
        topic,
      });

      const didSubscribe = await new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          fail(new Error(`Mammotion MQTT subscribe timeout for ${topic}`));
        }, 8_000);
        const cleanup = (): void => {
          clearTimeout(timer);
          client.off("close", onClose);
          client.off("error", onError);
        };
        const finish = (value: boolean): void => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(value);
        };
        const fail = (error: Error): void => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          reject(error);
        };
        const onClose = (): void => {
          this.log("Mammotion MQTT subscription deferred: connection closed while subscribing", {
            deviceName: target.deviceName,
            iotId: target.iotId,
            productKey: target.productKey,
            topic,
          });
          finish(false);
        };
        const onError = (error: Error): void => {
          fail(error);
        };

        client.once("close", onClose);
        client.once("error", onError);
        client.subscribe(topic, (error, granted) => {
          if (settled) {
            return;
          }

          if (error) {
            if (required) {
              fail(error);
            } else {
              this.log("Mammotion optional MQTT subscription failed", {
                deviceName: target.deviceName,
                iotId: target.iotId,
                message: error.message,
                productKey: target.productKey,
                topic,
              });
              finish(false);
            }
            return;
          }

          if (granted?.some((grant) => grant.qos === 128)) {
            const error = new Error(`Mammotion MQTT subscription rejected for ${topic}`);

            if (required) {
              fail(error);
            } else {
              this.log("Mammotion optional MQTT subscription rejected", {
                deviceName: target.deviceName,
                iotId: target.iotId,
                productKey: target.productKey,
                topic,
              });
              finish(false);
            }
            return;
          }

          this.mqttSubscribedTopics.add(topic);
          finish(true);
        });
      });

      if (didSubscribe) {
        subscribed += 1;
      } else {
        deferred += 1;

        if (!client.connected) {
          break;
        }
      }
    }

    this.log("Mammotion MQTT subscribed for mower", {
      deviceName: target.deviceName,
      deferred,
      iotId: target.iotId,
      productKey: target.productKey,
      subscribed,
      topics: topics.length,
    });
  }

  private async subscribeKnownMqttTargets(): Promise<void> {
    const targetsByKey = new Map<string, MammotionTopicTarget>();

    for (const target of this.mqttTargetByTopicKey.values()) {
      targetsByKey.set(`${target.productKey}/${target.deviceName}`, target);
    }

    for (const target of targetsByKey.values()) {
      await this.subscribeMqttTarget(target).catch((error: unknown) => {
        this.error("Mammotion MQTT resubscribe failed", {
          deviceName: target.deviceName,
          iotId: target.iotId,
          message: error instanceof Error ? error.message : String(error),
          productKey: target.productKey,
        });
      });

      if (this.telemetryListenersByIotId.has(target.iotId)) {
        await this.syncMqttTransport(target).catch((error: unknown) => {
          this.error("Mammotion telemetry resync after reconnect failed", {
            deviceName: target.deviceName,
            iotId: target.iotId,
            message: error instanceof Error ? error.message : String(error),
            productKey: target.productKey,
          });
        });
      }
    }
  }

  private getMqttSubscribeTopics(target: MammotionTopicTarget): MammotionMqttSubscribeTopic[] {
    const base = `/sys/${target.productKey}/${target.deviceName}`;
    const protoBase = `/sys/proto/${target.productKey}/${target.deviceName}`;
    // This JWT only permits the two physical-device event namespaces. The
    // app/down topics are rejected by closing the broker connection.
    const topics = [
      `${base}/thing/event/+/post`,
      `${protoBase}/thing/event/+/post`,
    ];

    return [...new Set(topics)].map((topic) => ({
      required: false,
      topic,
    }));
  }

  private handleMqttMessage(topic: string, payload: Buffer): void {
    const target = this.getMqttTargetForTopic(topic, payload);

    if (!target) {
      return;
    }

    const payloadText = payload.toString("utf8");
    const payloadData = normalizeMqttPayloadData(payloadText);
    const jsonTelemetry = parseMqttJsonTelemetryPayload(payloadText);
    const content = this.extractMqttMessageContent(topic, payload);
    const isWaitingForAreas = this.isWaitingForAreaData(target.iotId);

    if (jsonTelemetry) {
      this.emitTelemetry(target.iotId, jsonTelemetry);
    }

    if (!content) {
      if (isWaitingForAreas) {
        this.log("Mammotion MQTT area wait message without proto content", {
          bytes: payload.length,
          iotId: target.iotId,
          topic,
        });
      }

      return;
    }

    if (isWaitingForAreas && this.shouldLogMqttAreaWaitContent(target.iotId, content)) {
      this.log("Mammotion MQTT area wait proto content received", {
        bytes: payload.length,
        contentChars: content.length,
        iotId: target.iotId,
        topic,
      });
    }

    this.rememberAreasFromContent({
      content,
      iotId: target.iotId,
      source: "mqtt",
    });

    this.resolveMowingCommandAcknowledgements(target.iotId, content);

    const telemetry = this.dnaMethods.parseTelemetry(content);

    if (telemetry) {
      this.emitTelemetry(target.iotId, telemetry);
    }

    const hashes = this.dnaMethods.parseAreaHashes(content, target.iotId);

    if (hashes.length && this.shouldClassifyMqttAreaHashes(target.iotId, hashes)) {
      void this.classifyAreaHashes({
        hashes,
        source: "mqtt_hash_list",
        target,
      }).catch((error: unknown) => {
        this.error("Mammotion area hash classification failed", {
          deviceName: target.deviceName,
          hashes: hashes.length,
          iotId: target.iotId,
          message: error instanceof Error ? error.message : String(error),
          productKey: target.productKey,
        });
      });
    }
  }

  private emitTelemetry(iotId: string, telemetry: MammotionTelemetry): void {
    for (const listener of this.telemetryListenersByIotId.get(iotId) || []) {
      void Promise.resolve(listener(telemetry)).catch((error: unknown) => {
        this.error("Mammotion telemetry listener failed", {
          iotId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private isWaitingForAreaData(iotId: string): boolean {
    if (this.isCollectingAreaData(iotId)) {
      return true;
    }

    for (const key of this.areaHashInfoWaitersByKey.keys()) {
      if (key.startsWith(`${iotId}:`)) {
        return true;
      }
    }

    return false;
  }

  private hasAreaWaiters(iotId: string): boolean {
    return this.areaWaitersByIotId.has(iotId);
  }

  private isCollectingAreaData(iotId: string): boolean {
    return this.hasAreaWaiters(iotId) || this.areaRefreshActiveIotIds.has(iotId);
  }

  private shouldLogMqttAreaWaitContent(iotId: string, content: string): boolean {
    const logKey = [
      content.length,
      this.dnaMethods.summarizeAreaSignals(content).join("|"),
      this.dnaMethods.summarizeProtoFields(content).join("|"),
    ].join(":");

    if (this.mqttAreaWaitLogKeyByIotId.get(iotId) === logKey) {
      return false;
    }

    this.mqttAreaWaitLogKeyByIotId.set(iotId, logKey);

    return true;
  }

  private getMqttTargetForTopic(topic: string, payload: Buffer): MammotionTopicTarget | undefined {
    const parts = topic.split("/");
    const isProtoTopic = parts[1] === "sys" && parts[2] === "proto";
    const productKey = isProtoTopic ? parts[3] : parts[2];
    const deviceName = isProtoTopic ? parts[4] : parts[3];
    const topicTarget = this.mqttTargetByTopicKey.get(`${productKey}/${deviceName}`);

    if (topicTarget) {
      return topicTarget;
    }

    const payloadData = parseJsonObject(payload.toString("utf8"));
    const params = getObject(payloadData?.params);
    const data = getObject(payloadData?.data);
    const iotId = [
      params?.iotId,
      params?.iot_id,
      data?.iotId,
      data?.iot_id,
      payloadData?.iotId,
      payloadData?.iot_id,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);

    if (iotId) {
      return [...this.mqttTargetByTopicKey.values()].find((target) => target.iotId === iotId);
    }

    const waitingTargets = [...this.mqttTargetByTopicKey.values()]
      .filter((target) => this.isWaitingForAreaData(target.iotId));

    if (waitingTargets.length === 1) {
      return waitingTargets[0];
    }

    const targets = [...this.mqttTargetByTopicKey.values()];

    return targets.length === 1 ? targets[0] : undefined;
  }

  private extractMqttMessageContent(topic: string, payload: Buffer): string | undefined {
    const isRawProto = topic.includes("/down_raw") || topic.startsWith("/sys/proto/");
    const payloadText = payload.toString("utf8");
    const payloadData = normalizeMqttPayloadData(payloadText);

    if (isRawProto && !payloadData) {
      return payload.toString("base64");
    }

    if (!payloadData) {
      return undefined;
    }

    return extractMqttProtoContent(payloadData);
  }

  private rememberAreasFromContent({
    content,
    iotId,
    source,
  }: {
    content: string;
    iotId: string;
    source: string;
  }): MammotionArea[] {
    const hashInfos = this.dnaMethods.parseAreaHashInfos(content);
    const namedAreas = this.dnaMethods.parseAreaNames(content);
    const areaHashes = this.dnaMethods.parseAreaHashes(content, iotId);

    if (!hashInfos.length && !namedAreas.length && !areaHashes.length) {
      const areaSignals = this.dnaMethods.summarizeAreaSignals(content);
      const protoFields = this.dnaMethods.summarizeProtoFields(content);
      const logKey = `${source}:${content.length}:${areaSignals.join("|")}:${protoFields.join("|")}`;

      if (this.areaNoZoneLogKeyByIotId.get(iotId) === logKey) {
        return this.getCachedAreas(iotId);
      }

      this.areaNoZoneLogKeyByIotId.set(iotId, logKey);
      this.log("Mammotion area content parsed without zones", {
        areaSignals,
        contentChars: content.length,
        iotId,
        protoFields,
        source,
      });

      return this.getCachedAreas(iotId);
    }

    if (!hashInfos.length && !namedAreas.length && areaHashes.length) {
      const hashSetKey = this.getAreaHashSetKey(areaHashes);
      const logKey = `${source}:${hashSetKey}`;

      if (this.areaHashLogKeyByIotId.get(iotId) === logKey) {
        return this.getCachedAreas(iotId);
      }

      this.areaHashLogKeyByIotId.set(iotId, logKey);
      this.log("Mammotion area hashes received", {
        areaSignals: this.dnaMethods.summarizeAreaSignals(content),
        areaHashes: areaHashes.length,
        contentChars: content.length,
        iotId,
        source,
      });

      return this.getCachedAreas(iotId);
    }

    const areasByHash = this.areasByIotId.get(iotId) || new Map<string, MammotionArea>();

    this.resolveAreaHashInfoWaiters(iotId, hashInfos);

    for (const info of hashInfos) {
      if (info.type !== 0) {
        continue;
      }

      if (!areasByHash.has(info.hash) || info.name) {
        areasByHash.set(info.hash, {
          hash: info.hash,
          name: info.name || areasByHash.get(info.hash)?.name || `Area ${areasByHash.size + 1}`,
        });
      }
    }

    for (const area of namedAreas) {
      areasByHash.set(area.hash, area);
    }

    this.areasByIotId.set(iotId, areasByHash);

    this.log("Mammotion areas received", {
      areaHashes: areaHashes.length,
      areaHashInfos: hashInfos.length,
      cached: areasByHash.size,
      iotId,
      namedAreas: namedAreas.length,
      source,
    });
    this.resolveAreaWaiters(iotId);

    return this.getCachedAreas(iotId);
  }

  private shouldClassifyMqttAreaHashes(iotId: string, hashes: string[]): boolean {
    if (!this.isCollectingAreaData(iotId)) {
      return false;
    }

    const hashSetKey = this.getAreaHashSetKey(hashes);

    if (!hashSetKey) {
      return false;
    }

    if (this.mqttAreaHashClassificationKeyByIotId.get(iotId) === hashSetKey) {
      return false;
    }

    this.mqttAreaHashClassificationKeyByIotId.set(iotId, hashSetKey);

    return true;
  }

  private getAreaHashSetKey(hashes: string[]): string {
    return [...new Set(hashes.filter((hash) => /^\d+$/.test(hash)))]
      .sort((first, second) => {
        const firstHash = BigInt(first);
        const secondHash = BigInt(second);

        if (firstHash < secondHash) {
          return -1;
        }

        if (firstHash > secondHash) {
          return 1;
        }

        return 0;
      })
      .join(",");
  }

  private async classifyAreaHashes({
    hashes,
    source,
    target,
  }: {
    hashes: string[];
    source: string;
    target: MammotionCommandTarget;
  }): Promise<MammotionArea[]> {
    const uniqueHashes = [...new Set(hashes)].filter((hash) => /^\d+$/.test(hash));

    if (!uniqueHashes.length) {
      return [];
    }

    const currentClassification = this.areaHashClassificationByIotId.get(target.iotId);

    if (currentClassification) {
      return await currentClassification;
    }

    const classification = this.classifyAreaHashesInternal({
      hashes: uniqueHashes,
      source,
      target,
    }).finally(() => {
      this.areaHashClassificationByIotId.delete(target.iotId);
    });

    this.areaHashClassificationByIotId.set(target.iotId, classification);

    return await classification;
  }

  private async classifyAreaHashesInternal({
    hashes,
    source,
    target,
  }: {
    hashes: string[];
    source: string;
    target: MammotionCommandTarget;
  }): Promise<MammotionArea[]> {
    const areaInfos: MammotionAreaHashInfo[] = [];
    const typeCounts = new Map<number, number>();

    this.log("Mammotion area hash classification started", {
      deviceName: target.deviceName || "<missing>",
      hashes: hashes.length,
      iotId: target.iotId,
      productKey: target.productKey || "<missing>",
      source,
    });

    let processedHashes = 0;

    for (const hash of hashes) {
      if (source === "mqtt_hash_list" && !this.isCollectingAreaData(target.iotId)) {
        this.log("Mammotion area hash classification stopped", {
          deviceName: target.deviceName || "<missing>",
          iotId: target.iotId,
          productKey: target.productKey || "<missing>",
          reason: "area refresh waiter ended",
          remainingHashes: hashes.length - processedHashes,
          source,
        });
        break;
      }

      const info = await this.requestAreaHashInfo({
        hash: BigInt(hash),
        target,
      });
      const type = info?.type ?? -1;

      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);

      if (!info) {
        processedHashes += 1;
        continue;
      }

      if (info?.type === 0) {
        areaInfos.push(info);
      }

      processedHashes += 1;
    }

    const areas = this.buildAreasFromHashInfos(target.iotId, areaInfos);
    const typeSummary = [...typeCounts.entries()]
      .sort((first, second) => first[0] - second[0])
      .map(([type, count]) => `${type}:${count}`);

    if (areas.length) {
      const areasByHash = this.areasByIotId.get(target.iotId) || new Map<string, MammotionArea>();

      for (const area of areas) {
        areasByHash.set(area.hash, area);
      }

      this.areasByIotId.set(target.iotId, areasByHash);
      this.resolveAreaWaiters(target.iotId);
    } else if (source === "mqtt_hash_list" && this.hasAreaWaiters(target.iotId)) {
      this.log("Mammotion area wait completed without zones", {
        deviceName: target.deviceName || "<missing>",
        hashes: hashes.length,
        iotId: target.iotId,
        productKey: target.productKey || "<missing>",
        source,
      });
      this.resolveAreaWaiters(target.iotId);
    }

    this.log("Mammotion area hash classification completed", {
      areas: areas.length,
      deviceName: target.deviceName || "<missing>",
      hashes: hashes.length,
      iotId: target.iotId,
      productKey: target.productKey || "<missing>",
      source,
      types: typeSummary,
    });

    return areas;
  }

  private buildAreasFromHashInfos(iotId: string, infos: MammotionAreaHashInfo[]): MammotionArea[] {
    const existingAreas = new Map(this.getCachedAreas(iotId).map((area) => [area.hash, area]));
    const usedNames = new Set<string>();
    const areas: MammotionArea[] = [];
    let nextFallbackIndex = 1;
    const nextFallbackName = (): string => {
      while (true) {
        const name = `Area ${nextFallbackIndex++}`;

        if (!usedNames.has(name.toLowerCase())) {
          return name;
        }
      }
    };

    for (const info of infos) {
      let name = info.name?.trim() || existingAreas.get(info.hash)?.name || "";

      if (!name || usedNames.has(name.toLowerCase())) {
        name = nextFallbackName();
      }

      usedNames.add(name.toLowerCase());
      areas.push({
        hash: info.hash,
        name,
      });
    }

    return areas;
  }

  private async requestAreaHashInfo({
    hash,
    target,
  }: {
    hash: bigint;
    target: MammotionCommandTarget;
  }): Promise<MammotionAreaHashInfo | undefined> {
    const cachedArea = this.getCachedAreas(target.iotId).find((area) => area.hash === hash.toString());

    if (cachedArea) {
      return {
        hash: cachedArea.hash,
        name: cachedArea.name,
        type: 0,
      };
    }

    const waitKey = this.getAreaHashInfoWaitKey(target.iotId, hash.toString());
    const receiverDevices = this.getAreaHashInfoReceiverCandidates(target);

    for (const receiverDevice of receiverDevices) {
      const waitPromise = this.waitForAreaHashInfo(waitKey);

      try {
        const result = await this.invokeDeviceCommand({
          payload: this.dnaMethods.buildAreaHashInfoCommand({
            hash,
            receiverDevice,
            target,
            userAccount: this.getUserAccountSubtype(),
          }),
          target,
          skipMqttSync: true,
          type: `area_hash_info:${hash}:receiver_${receiverDevice}`,
        });

        if (result !== "ok") {
          const hashInfos = this.dnaMethods.parseAreaHashInfos(result);
          const matchedInfo = hashInfos.find((info) => info.hash === hash.toString());

          this.rememberAreasFromContent({
            content: result,
            iotId: target.iotId,
            source: `area_hash_info:receiver_${receiverDevice}`,
          });

          if (matchedInfo) {
            this.resolveAreaHashInfoWaiter(waitKey, matchedInfo);
          }
          // The RPC result commonly contains only a generic acknowledgement.
          // The matching NavGetCommDataAck arrives asynchronously over MQTT,
          // so keep the waiter alive when this response has no matching hash.
        }
      } catch (error: unknown) {
        this.error("Mammotion area hash info request failed", {
          hash: hash.toString(),
          iotId: target.iotId,
          message: error instanceof Error ? error.message : String(error),
          receiverDevice,
        });
        this.resolveAreaHashInfoWaiter(waitKey, undefined);
      }

      const info = await waitPromise;

      if (info) {
        this.log("Mammotion area hash info received", {
          hash: hash.toString(),
          iotId: target.iotId,
          receiverDevice,
          type: info.type,
        });

        return info;
      }
    }

    return undefined;
  }

  private waitForAreaHashInfo(waitKey: string): Promise<MammotionAreaHashInfo | undefined> {
    return new Promise((resolve) => {
      const waiter: AreaHashInfoWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeAreaHashInfoWaiter(waitKey, waiter);
          resolve(undefined);
        }, AREA_HASH_INFO_WAIT_MS),
      };
      const waiters = this.areaHashInfoWaitersByKey.get(waitKey) || new Set<AreaHashInfoWaiter>();

      waiters.add(waiter);
      this.areaHashInfoWaitersByKey.set(waitKey, waiters);
    });
  }

  private resolveAreaHashInfoWaiters(iotId: string, infos: MammotionAreaHashInfo[]): void {
    for (const info of infos) {
      this.resolveAreaHashInfoWaiter(this.getAreaHashInfoWaitKey(iotId, info.hash), info);
    }
  }

  private resolveAreaHashInfoWaiter(waitKey: string, info: MammotionAreaHashInfo | undefined): void {
    const waiters = this.areaHashInfoWaitersByKey.get(waitKey);

    if (!waiters) {
      return;
    }

    this.areaHashInfoWaitersByKey.delete(waitKey);

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(info);
    }
  }

  private removeAreaHashInfoWaiter(waitKey: string, waiter: AreaHashInfoWaiter): void {
    const waiters = this.areaHashInfoWaitersByKey.get(waitKey);

    if (!waiters) {
      return;
    }

    waiters.delete(waiter);

    if (!waiters.size) {
      this.areaHashInfoWaitersByKey.delete(waitKey);
    }
  }

  private getAreaHashInfoWaitKey(iotId: string, hash: string): string {
    return `${iotId}:${hash}`;
  }

  private getCachedAreas(iotId: string): MammotionArea[] {
    const areasByHash = this.areasByIotId.get(iotId);

    if (!areasByHash) {
      return [];
    }

    return [...areasByHash.values()].sort((first, second) => first.name.localeCompare(second.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }));
  }

  private async waitForMqttAreas(iotId: string, timeoutMs: number): Promise<MammotionArea[]> {
    const cachedAreas = this.getCachedAreas(iotId);

    if (cachedAreas.length) {
      return cachedAreas;
    }

    await new Promise<void>((resolve) => {
      const waiter: AreaWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeAreaWaiter(iotId, waiter);
          resolve();
        }, timeoutMs),
      };
      const waiters = this.areaWaitersByIotId.get(iotId) || new Set<AreaWaiter>();

      waiters.add(waiter);
      this.areaWaitersByIotId.set(iotId, waiters);
    });

    return this.getCachedAreas(iotId);
  }

  private resolveAreaWaiters(iotId: string): void {
    const waiters = this.areaWaitersByIotId.get(iotId);

    if (!waiters) {
      return;
    }

    this.areaWaitersByIotId.delete(iotId);

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private removeAreaWaiter(iotId: string, waiter: AreaWaiter): void {
    const waiters = this.areaWaitersByIotId.get(iotId);

    if (!waiters) {
      return;
    }

    waiters.delete(waiter);

    if (!waiters.size) {
      this.areaWaitersByIotId.delete(iotId);
    }
  }

  private getMowingCommandAckKey(iotId: string, acknowledgement: MowingCommandAck): string {
    return `${iotId}:${acknowledgement}`;
  }

  private createMowingCommandAckWaiter({
    acknowledgement,
    iotId,
  }: {
    acknowledgement: MowingCommandAck;
    iotId: string;
  }): {
    cancel(): void;
    promise: Promise<boolean>;
  } {
    const key = this.getMowingCommandAckKey(iotId, acknowledgement);
    let waiter: MowingCommandAckWaiter;
    const promise = new Promise<boolean>((resolve) => {
      waiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeMowingCommandAckWaiter(key, waiter);
          resolve(false);
        }, MOWING_COMMAND_ACK_WAIT_MS),
      };
      const waiters = this.mowingCommandAckWaitersByKey.get(key) || new Set<MowingCommandAckWaiter>();

      waiters.add(waiter);
      this.mowingCommandAckWaitersByKey.set(key, waiters);
    });

    return {
      cancel: () => {
        this.removeMowingCommandAckWaiter(key, waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      },
      promise,
    };
  }

  private removeMowingCommandAckWaiter(key: string, waiter: MowingCommandAckWaiter): void {
    const waiters = this.mowingCommandAckWaitersByKey.get(key);

    if (!waiters) {
      return;
    }

    waiters.delete(waiter);

    if (!waiters.size) {
      this.mowingCommandAckWaitersByKey.delete(key);
    }
  }

  private resolveMowingCommandAcknowledgements(iotId: string, content: string): void {
    const acknowledgements = this.dnaMethods.parseCommandAcknowledgements(content);

    if (acknowledgements.routeConfirmed) {
      const key = this.getMowingCommandAckKey(iotId, "route_confirmed");
      const confirmed = acknowledgements.routeResult === 0;

      this.resolveMowingCommandAckWaiters(key, confirmed);
    }

    if (acknowledgements.taskStarted) {
      this.resolveMowingCommandAckWaiters(
        this.getMowingCommandAckKey(iotId, "task_started"),
        true,
      );
    }
  }

  private resolveMowingCommandAckWaiters(key: string, confirmed: boolean): void {
    const waiters = this.mowingCommandAckWaitersByKey.get(key);

    if (!waiters) {
      return;
    }

    this.mowingCommandAckWaitersByKey.delete(key);

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(confirmed);
    }
  }

  private async invokeDeviceCommandAndWaitForMowingAck({
    acknowledgement,
    payload,
    target,
    type,
  }: {
    acknowledgement: MowingCommandAck;
    payload: Buffer;
    target: MammotionCommandTarget;
    type: string;
  }): Promise<void> {
    await this.ensureMqttForTarget(target);
    await this.syncMqttTransport(target);

    const waiter = this.createMowingCommandAckWaiter({
      acknowledgement,
      iotId: target.iotId,
    });

    try {
      const result = await this.postDeviceCommand({ payload, target, type });

      this.resolveMowingCommandAcknowledgements(target.iotId, result);

      if (!await waiter.promise) {
        throw new OAuth2Error(
          acknowledgement === "route_confirmed"
            ? "Mower did not confirm the generated mowing route"
            : "Mower did not confirm that mowing started",
        );
      }

      this.log("Mammotion mowing command confirmed", {
        acknowledgement,
        iotId: target.iotId,
        type,
      });
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async invokeDeviceCommand({
    payload,
    skipMqttSync = false,
    target,
    type = "command",
  }: {
    payload: Buffer;
    skipMqttSync?: boolean;
    target: MammotionCommandTarget;
    type?: string;
  }): Promise<string> {
    await this.ensureMqttForTarget(target).catch((error: unknown) => {
      this.error("Mammotion MQTT command monitoring unavailable", {
        deviceName: target.deviceName || "<missing>",
        iotId: target.iotId,
        message: error instanceof Error ? error.message : String(error),
        productKey: target.productKey || "<missing>",
        type,
      });
      this.scheduleMqttReconnect("command monitoring setup failed");
    });

    if (!skipMqttSync) {
      await this.syncMqttTransport(target);
    }

    return await this.postDeviceCommand({ payload, target, type });
  }

  private async syncMqttTransport(target: MammotionCommandTarget): Promise<void> {
    const lastSync = this.mqttSyncByIotId.get(target.iotId) || 0;
    const now = Date.now();

    if (now - lastSync < MQTT_SYNC_INTERVAL_MS) {
      return;
    }

    const result = await this.postDeviceCommand({
      payload: this.dnaMethods.buildRequestIotSyncCommand({
        userAccount: this.getUserAccountSubtype(),
      }),
      target,
      type: "mqtt_sync",
    });
    this.processMqttSyncResult(target, result);
    this.mqttSyncByIotId.set(target.iotId, Date.now());
  }

  private processMqttSyncResult(target: MammotionCommandTarget, result: string): void {
    const jsonTelemetry = parseMqttJsonTelemetryPayload(result);

    if (jsonTelemetry) {
      this.mqttSyncDecodeLogKeyByIotId.set(target.iotId, "json-telemetry");
      this.emitTelemetry(target.iotId, jsonTelemetry);
      return;
    }

    const resultObject = parseJsonObject(result);
    const content = resultObject ? extractMqttProtoContent(resultObject) : undefined;
    const normalizedContent = content || result;
    const telemetry = this.dnaMethods.parseTelemetry(normalizedContent);

    if (telemetry) {
      this.mqttSyncDecodeLogKeyByIotId.set(target.iotId, "telemetry");
      this.emitTelemetry(target.iotId, telemetry);
      return;
    }

    const jsonKeys = resultObject ? Object.keys(resultObject).sort() : [];
    const protoFields = this.dnaMethods.summarizeProtoFields(normalizedContent);
    const logKey = `${result.length}:${jsonKeys.join(",")}:${protoFields.join(",")}`;

    if (this.mqttSyncDecodeLogKeyByIotId.get(target.iotId) === logKey) {
      return;
    }

    this.mqttSyncDecodeLogKeyByIotId.set(target.iotId, logKey);
    this.log("Mammotion MQTT sync response contained no mower telemetry", {
      iotId: target.iotId,
      jsonKeys,
      protoFields,
      resultChars: result.length,
    });
  }

  private async postDeviceCommand({
    payload,
    target,
    type,
  }: {
    payload: Buffer;
    target: MammotionCommandTarget;
    type: string;
  }): Promise<string> {
    const iotDomain = getIotDomain((this.getToken() as MammotionOAuth2Token | null)?.access_token);

    if (!iotDomain) {
      throw new OAuth2Error("Mammotion token does not contain an IoT endpoint");
    }

    const requestId = createRequestId();
    const invoke = async ({
      deviceName,
      productKey,
      requestType,
    }: {
      deviceName: string;
      productKey: string;
      requestType: string;
    }): Promise<MammotionResponse<unknown>> => {
      this.log("Mammotion command request", {
        bytes: payload.length,
        deviceName: deviceName || "<empty>",
        iotId: target.iotId,
        productKey: productKey || "<empty>",
        requestId,
        type: requestType,
        userAccount: this.getUserAccountSubtype(),
      });

      return await this.post({
        path: `${iotDomain}/v1/mqtt/rpc/thing/service/invoke`,
        json: {
          args: {
            content: payload.toString("base64"),
          },
          deviceName,
          identifier: "device_protobuf_sync_service",
          iotId: target.iotId,
          productKey,
        },
        headers: {
          "Accept-Language": "en-US",
          "Client-Id": this.mammotionClientId,
          "Client-Type": CLIENT_TYPE,
          "Content-Type": "application/json",
          "L-T-Z": `${Math.floor(Date.now() / 1000)}/0/0`,
          "Request-Id": requestId,
          "User-Agent": "okhttp/4.9.3",
        },
      }) as MammotionResponse<unknown>;
    };

    let response = await invoke({
      deviceName: target.deviceName || "",
      productKey: target.productKey || "",
      requestType: type,
    });

    if (response.code === 50101 && (target.deviceName || target.productKey)) {
      this.log("Mammotion command retrying without device identity", {
        code: response.code,
        iotId: target.iotId,
        msg: response.msg || "",
        requestId: response.requestId || requestId,
        type,
      });

      response = await invoke({
        deviceName: "",
        productKey: "",
        requestType: `${type}:empty_identity_retry`,
      });
    }

    this.log("Mammotion command response", {
      code: response.code,
      msg: response.msg || "",
      requestId: response.requestId || requestId,
      resultBytes: extractMammotionCommandResult(response.data)?.length || 0,
      type,
    });

    assertMammotionCommandSuccess(response, "Mammotion command failed");

    return extractMammotionCommandResult(response.data) || "ok";
  }

  async onRequestHeaders({
    headers,
  }: {
    headers: Record<string, string>;
  }): Promise<Record<string, string>> {
    return {
      ...await super.onRequestHeaders({ headers }),
      "App-Version": this.getAppVersionHeader(),
      "Client-Id": this.mammotionClientId,
      "Client-Type": CLIENT_TYPE,
      "User-Agent": "okhttp/4.9.3",
    };
  }

  async onHandleNotOK({
    body,
    status,
    statusText,
  }: {
    body: unknown;
    status: number;
    statusText: string;
  }): Promise<Error> {
    const message = typeof body === "object" && body && "msg" in body
      ? String((body as { msg?: unknown }).msg)
      : `${status} ${statusText || "Mammotion API error"}`;

    return new OAuth2Error(message, status);
  }

  private async getOwnedDevices(): Promise<MammotionDeviceInfo[]> {
    const response = await this.get({
      path: "/device-server/v1/device/list",
    }) as MammotionResponse<MammotionDeviceInfo[]>;

    return assertMammotionSuccess(response, "Could not load Mammotion devices");
  }

  private async getPagedDevices(): Promise<MammotionDeviceRecord[]> {
    const iotDomain = getIotDomain((this.getToken() as MammotionOAuth2Token | null)?.access_token);

    if (!iotDomain) {
      return [];
    }

    const response = await this.post({
      path: `${iotDomain}/v1/user/device/page`,
      json: {
        iotId: "",
        pageNumber: 1,
        pageSize: 100,
      },
    }) as MammotionResponse<MammotionDeviceRecords>;
    const data = assertMammotionSuccess(response, "Could not load Mammotion device page");

    return data.records || [];
  }

  private async getSharedDevices(): Promise<MammotionShareRecord[]> {
    const response = await this.post({
      path: "/user-server/v1/share/device/page",
      json: {
        iotId: "",
        owned: 0,
        pageNumber: 1,
        pageSize: 200,
        statusList: [-1, 0, 1],
      },
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "okhttp/4.9.3",
      },
    }) as MammotionResponse<MammotionShareRecords>;

    if (response.code !== 0) {
      this.log("Mammotion shared-device discovery skipped", {
        code: response.code,
        msg: response.msg || "",
      });
      return [];
    }

    return response.data?.records || [];
  }

  private async getMqttCredentials(): Promise<MammotionMqttConnection> {
    const iotDomain = getIotDomain((this.getToken() as MammotionOAuth2Token | null)?.access_token);

    if (!iotDomain) {
      throw new OAuth2Error("Mammotion token does not contain an IoT endpoint");
    }

    const response = await this.post({
      path: `${iotDomain}/v1/mqtt/auth/jwt`,
      json: {},
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "okhttp/4.9.3",
      },
    }) as MammotionResponse<MammotionMqttConnection>;

    return assertMammotionSuccess(response, "Could not load Mammotion MQTT credentials");
  }

  private hasSignedOAuth2Client(): boolean {
    return Boolean(
      getOptionalEnv("MAMMOTION_AUTH_FLOW") === "signed_oauth2"
      &&
      getOptionalEnv("MAMMOTION_OAUTH2_CLIENT_ID")
      && getOptionalEnv("MAMMOTION_OAUTH2_CLIENT_SECRET"),
    );
  }

  private getUserAccountSubtype(): number {
    const token = this.getToken() as MammotionOAuth2Token | null;
    const value = token?.userInformation?.userAccount;

    if (typeof value !== "string" && typeof value !== "number") {
      return 0;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }

  private async requestLegacyPasswordToken({
    username,
    password,
  }: {
    username: string;
    password: string;
  }): Promise<MammotionOAuth2Token> {
    const keys = createLegacyEncryptionKeys();
    const url = new URL(`${MAMMOTION_ID_DOMAIN}${LEGACY_TOKEN_PATH}`);

    url.searchParams.set("username", encryptAesCbc(username, keys));
    url.searchParams.set("password", encryptAesCbc(password, keys));
    url.searchParams.set("client_id", encryptAesCbc(LEGACY_CLIENT_ID, keys));
    url.searchParams.set("client_secret", encryptAesCbc(LEGACY_CLIENT_SECRET, keys));
    url.searchParams.set("grant_type", encryptAesCbc("password", keys));

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "App-Version": this.getAppVersionHeader(),
        "Decrypt-Type": "3",
        "Ec-Version": "v1",
        "Encrypt-Key": encryptLegacySessionKey(keys),
        "User-Agent": "okhttp/4.9.3",
      },
    });
    const body = await response.json() as MammotionResponse<MammotionLoginData>;

    if (!response.ok || body.code !== 0) {
      throw new OAuth2Error(body.msg || "Mammotion authentication failed", response.status);
    }

    return new MammotionOAuth2Token(assertMammotionSuccess(body, "Mammotion authentication failed"));
  }

  private async requestSignedToken({
    request,
    signatureHeader,
  }: {
    request: TokenRequest;
    signatureHeader: "Ma-Signature" | "Ma-Iot-Signature";
  }): Promise<MammotionOAuth2Token> {
    const clientId = getOptionalEnv("MAMMOTION_OAUTH2_CLIENT_ID");
    const clientSecret = getOptionalEnv("MAMMOTION_OAUTH2_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      throw new OAuth2Error("Missing Mammotion OAuth2 app client id or secret");
    }

    const timestamp = Date.now();
    const signature = createOAuthSignature({
      clientId,
      clientSecret,
      request,
      timestamp,
    });
    const url = new URL(`${MAMMOTION_ID_DOMAIN}${TOKEN_PATH}`);

    for (const [key, value] of Object.entries(request)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      "App-Version": this.getAppVersionHeader(),
      "Client-Id": this.mammotionClientId,
      "Client-Type": CLIENT_TYPE,
      "Ma-Timestamp": String(timestamp),
      "User-Agent": "okhttp/4.9.3",
      [signatureHeader]: signature,
    };

    if (signatureHeader === "Ma-Signature") {
      headers["Ma-App-Key"] = clientId;
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
    });
    const responseText = await response.text();
    let body: MammotionResponse<MammotionLoginData>;

    try {
      body = JSON.parse(responseText) as MammotionResponse<MammotionLoginData>;
    } catch {
      this.error("Mammotion OAuth2 returned a non-JSON response", {
        status: response.status,
        contentType: response.headers.get("content-type") || "",
      });
      throw new OAuth2Error(
        response.status === 429
          ? "Mammotion temporarily limited login attempts. Please wait before trying again."
          : `Mammotion login service returned an invalid response (HTTP ${response.status})`,
      );
    }

    if (!response.ok || body.code !== 0) {
      this.error("Mammotion OAuth2 rejected the request", {
        status: response.status,
        code: body.code,
        msg: body.msg || "",
      });
      throw new OAuth2Error(body.msg || "Mammotion authentication failed", response.status);
    }

    return new MammotionOAuth2Token(assertMammotionSuccess(body, "Mammotion authentication failed"));
  }

  private getAppVersionHeader(): string {
    const version = this.homey?.manifest?.version;

    return version ? `Homey,${version}` : DEFAULT_APP_VERSION;
  }
}
