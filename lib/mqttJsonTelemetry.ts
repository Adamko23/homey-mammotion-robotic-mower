import type { MammotionTelemetry } from "./mammotionProtocol";

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

export function normalizeMqttPayloadData(payloadText: string): Record<string, unknown> | undefined {
  const payloadData = parseJsonObject(payloadText);

  if (!payloadData) {
    return undefined;
  }

  const params = typeof payloadData.params === "string"
    ? parseJsonObject(payloadData.params)
    : getObject(payloadData.params);
  const data = typeof payloadData.data === "string"
    ? parseJsonObject(payloadData.data)
    : getObject(payloadData.data);

  return {
    ...payloadData,
    ...(data ? { data } : {}),
    ...(params ? { params } : {}),
  };
}

function unwrapMqttValue(value: unknown): unknown {
  const object = getObject(value);

  return object && "value" in object ? object.value : value;
}

function getFiniteMqttNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const unwrapped = unwrapMqttValue(value);
    const parsed = typeof unwrapped === "number"
      ? unwrapped
      : typeof unwrapped === "string" && unwrapped.trim()
        ? Number(unwrapped)
        : Number.NaN;

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getMqttField(containers: Array<Record<string, unknown> | undefined>, field: string): unknown[] {
  return containers.map((container) => container?.[field]);
}

export function parseMqttJsonTelemetryPayload(payloadText: string): MammotionTelemetry | null {
  const payloadData = normalizeMqttPayloadData(payloadText);

  if (!payloadData) {
    return null;
  }

  const params = getObject(payloadData.params);
  const data = getObject(payloadData.data);
  const paramsItems = getObject(params?.items);
  const dataItems = getObject(data?.items);
  const containers = [paramsItems, dataItems, params, data, payloadData];
  const onlineValue = getFiniteMqttNumber(
    ...getMqttField(containers, "status"),
    ...getMqttField(containers, "iotState"),
  );
  const batteryPercent = getFiniteMqttNumber(...getMqttField(containers, "batteryPercentage"));
  const bladeHeightMm = getFiniteMqttNumber(...getMqttField(containers, "knifeHeight"));
  const stateCode = getFiniteMqttNumber(...getMqttField(containers, "deviceState"));
  const chargeState = getFiniteMqttNumber(...getMqttField(containers, "chargeState"));
  const errorCode = getFiniteMqttNumber(
    ...getMqttField(containers, "errorCode"),
    ...getMqttField(containers, "deviceError"),
  );
  const mowingProgressPercent = getFiniteMqttNumber(
    ...getMqttField(containers, "taskProgress"),
    ...getMqttField(containers, "mowingProgress"),
  );
  const networkInfoValue = getMqttField(containers, "networkInfo")
    .map(unwrapMqttValue)
    .find((value) => value !== undefined && value !== null);
  const networkInfo = typeof networkInfoValue === "string"
    ? parseJsonObject(networkInfoValue)
    : getObject(networkInfoValue);
  const wifiRssi = getFiniteMqttNumber(networkInfo?.wifi_rssi);
  const totalWorkTimeSeconds = getFiniteMqttNumber(networkInfo?.wt_sec);
  const totalMileageMeters = getFiniteMqttNumber(networkInfo?.mileage);
  const firmwareValue = getMqttField(containers, "deviceVersion")
    .map(unwrapMqttValue)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const hasTelemetry = [
    onlineValue,
    batteryPercent,
    bladeHeightMm,
    stateCode,
    chargeState,
    errorCode,
    mowingProgressPercent,
    wifiRssi,
    totalWorkTimeSeconds,
    totalMileageMeters,
    firmwareValue,
  ].some((value) => value !== undefined);

  if (!hasTelemetry) {
    return null;
  }

  return {
    online: onlineValue === undefined ? true : onlineValue === 1,
    receivedAt: Date.now(),
    ...(batteryPercent !== undefined ? { batteryPercent } : {}),
    ...(bladeHeightMm !== undefined ? { bladeHeightMm } : {}),
    ...(stateCode !== undefined ? { stateCode } : {}),
    ...(chargeState !== undefined ? { chargeState } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(mowingProgressPercent !== undefined ? { mowingProgressPercent } : {}),
    ...(wifiRssi !== undefined ? { wifiRssi } : {}),
    ...(totalWorkTimeSeconds !== undefined ? { totalWorkTimeSeconds } : {}),
    ...(totalMileageMeters !== undefined ? { totalMileageMeters } : {}),
    ...(firmwareValue ? { firmwareVersion: firmwareValue } : {}),
  };
}
