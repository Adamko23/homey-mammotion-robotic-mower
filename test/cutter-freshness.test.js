"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

// Exercise the real device telemetry path without booting Homey or a mower client.
const originalLoad = Module._load;
let MowerDevice;
try {
  Module._load = function (request, ...args) {
    if (request === "homey-oauth2app") return { OAuth2Device: class {} };
    return originalLoad.call(this, request, ...args);
  };
  MowerDevice = require("../.homeybuild/drivers/mower/device");
} finally {
  Module._load = originalLoad;
}

function deviceFixture(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 8, 9, 11) });
  const values = new Map([
    ["mammotion_connection", "connected"],
    ["mammotion_state", "mowing"],
  ]);
  const device = new MowerDevice();
  device.hasCapability = () => true;
  device.getCapabilityValue = (key) => values.get(key) ?? null;
  device.setCapabilityValue = async (key, value) => { values.set(key, value); };
  device.setAvailable = async () => {};
  device.log = () => {};
  device.error = (...args) => assert.fail(args.join(" "));
  device.armTelemetryStaleTimer = () => {};
  device.hasLoggedTelemetrySnapshot = true;
  t.after(() => device.stopTelemetryMonitoring());
  const report = (data) => device.applyTelemetry({ online: true, receivedAt: Date.now(), ...data });
  return { device, report, values };
}

test("other fresh mower telemetry cannot keep an old positive blade RPM alive", async (t) => {
  const { device, report, values } = deviceFixture(t);
  await report({ cutterRpm: 3036 });
  const reportedAt = values.get("mammotion_cutter_last_update");
  t.mock.timers.tick(120_000);
  await report({ batteryPercent: 80 });
  assert.equal(values.get("mammotion_cutter_rpm"), 3036);
  t.mock.timers.tick(60_000);
  await device.telemetryQueue;
  assert.equal(values.get("mammotion_cutter_rpm"), null);
  assert.equal(values.get("mammotion_cutter_last_update"), `${reportedAt} · stale`);
  await report({ batteryPercent: 79 });
  assert.equal(values.get("mammotion_cutter_rpm"), null);
});

test("an unchanged RPM still refreshes its own timestamp and expiry", async (t) => {
  const { device, report, values } = deviceFixture(t);
  await report({ cutterRpm: 3036 });
  const firstReport = values.get("mammotion_cutter_last_update");
  t.mock.timers.tick(120_000);
  await report({ cutterRpm: 3036 });
  const secondReport = values.get("mammotion_cutter_last_update");
  assert.notEqual(secondReport, firstReport);
  t.mock.timers.tick(60_000);
  await device.telemetryQueue;
  assert.equal(values.get("mammotion_cutter_rpm"), 3036);
  t.mock.timers.tick(120_000);
  await device.telemetryQueue;
  assert.equal(values.get("mammotion_cutter_rpm"), null);
  assert.equal(values.get("mammotion_cutter_last_update"), `${secondReport} · stale`);
  await report({ cutterRpm: 0 });
  assert.equal(values.get("mammotion_cutter_rpm"), 0);
  assert.equal(values.get("mammotion_cutter_last_update"), new Date().toISOString());
});

test("device shutdown cancels pending cutter expiry", async (t) => {
  const { device, report, values } = deviceFixture(t);
  await report({ cutterRpm: 3036 });
  device.stopTelemetryMonitoring();
  t.mock.timers.tick(180_000);
  await device.telemetryQueue;
  assert.equal(values.get("mammotion_cutter_rpm"), 3036);
});

test("device displays task configuration and reported position separately", async (t) => {
  const { report, values } = deviceFixture(t);
  await report({ taskBladeHeightMm: 45 });
  await report({ bladeHeightMm: 70 });
  assert.equal(values.get("mammotion_task_blade_height"), 45);
  assert.equal(values.get("mammotion_blade_height"), 70);
});
