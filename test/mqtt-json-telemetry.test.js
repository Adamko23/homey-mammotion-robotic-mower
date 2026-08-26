"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseMqttJsonTelemetryPayload,
} = require("../.homeybuild/lib/mqttJsonTelemetry");

test("Mammotion property reports expose direct JSON mower status", () => {
  const telemetry = parseMqttJsonTelemetryPayload(JSON.stringify({
    params: JSON.stringify({
      items: {
        batteryPercentage: { value: 73 },
        deviceState: { value: 13 },
        deviceVersion: { value: "1.12.0" },
        iotState: { value: 1 },
        knifeHeight: { value: 60 },
        networkInfo: { value: JSON.stringify({ mileage: 1234, wifi_rssi: -61, wt_sec: 7200 }) },
      },
    }),
  }));

  assert.ok(telemetry);
  assert.equal(telemetry.online, true);
  assert.equal(telemetry.stateCode, 13);
  assert.equal(telemetry.batteryPercent, 73);
  assert.equal(telemetry.bladeHeightMm, 60);
  assert.equal(telemetry.firmwareVersion, "1.12.0");
  assert.equal(telemetry.wifiRssi, -61);
  assert.equal(telemetry.totalWorkTimeSeconds, 7200);
  assert.equal(telemetry.totalMileageMeters, 1234);
});

test("Mammotion JSON telemetry preserves an explicit offline report", () => {
  const telemetry = parseMqttJsonTelemetryPayload(JSON.stringify({
    params: {
      status: { value: 0 },
    },
  }));

  assert.ok(telemetry);
  assert.equal(telemetry.online, false);
});

test("unrelated MQTT JSON is not treated as mower telemetry", () => {
  assert.equal(parseMqttJsonTelemetryPayload('{"code":0,"msg":"ok"}'), null);
  assert.equal(parseMqttJsonTelemetryPayload("not-json"), null);
});
