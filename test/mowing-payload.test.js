"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decode } = require("./helpers/protobuf");
const Methods = require("../.homeybuild/lib/DNAngelXMammotionMethods").default;
const { normalizeStartMowingSettings } = require("../.homeybuild/lib/mammotionStartMowing");

const settings = normalizeStartMowingSettings({
  blade_height: 45, channel_mode: "1", speed: 0.3, path_spacing: 20,
  cutting_path_angle_mode: "2", border_laps: "2", mow_order: "0",
  obstacle_detection: "0", obstacle_laps: "0",
}, [9098484200456229175n, 1434946926024595423n, 6734916357287159095n]);

function routeFor(target) {
  const methods = new Methods();
  const envelope = decode(methods.buildRoutePlanningCommand({settings, target: {iotId: "test-mower", ...target}, userAccount: 42}));
  const route = decode(decode(envelope.get(11)[0]).get(34)[0]);
  return {envelope, route};
}

test("LUBA 2 Flow payload enables mowing tactics and preserves 45 mm and selected zones", () => {
  // PyMammotion device_config.create_path_order + DeviceType.is_luba_pro:
  // Luba-VS is LUBA_2, so reserved[5] must be 8, not ioBroker 0.0.7's 0.
  const {envelope, route} = routeFor({deviceName: "Luba-VS123456"});
  assert.equal(envelope.get(3)[0], 17n);
  assert.deepEqual([...route.get(15)[0]], [0, 0, 0, 0, 0, 8, 10, 0]);
  assert.equal(route.get(7)[0], 45n);
  assert.equal(route.get(4)[0], 4n);
  assert.equal(route.get(5)[0], 0n);
  assert.equal(route.get(6)[0], 2n);
  assert.equal(route.get(8)[0], 20n);
  assert.equal(route.get(10)[0], 1n);
  assert.equal(route.get(17)[0], 2n);
  assert.equal(route.get(18)[0], 90n);
  assert.deepEqual(route.get(13), settings.areaHashes);
  assert.ok(Math.abs(route.get(12)[0] - 0.3) < 0.00001);
});

test("LUBA 2 classification works with model metadata even without a device-name hint", () => {
  for (const target of [{deviceType: 2}, {deviceType: "2"}, {series: "LUBA 2 AWD 1000"}]) {
    const {envelope, route} = routeFor(target);
    assert.equal(envelope.get(3)[0], 17n);
    assert.equal(route.get(15)[0][5], 8);
  }
});

test("LUBA 1 and YUKA retain their distinct route format", () => {
  const luba1 = routeFor({deviceName: "Luba 1", deviceType: 1});
  assert.equal(luba1.envelope.get(3)[0], 1n);
  assert.deepEqual([...luba1.route.get(15)[0]], [0, 0, 0, 0, 2, 0, 0, 0]);
  const yuka = routeFor({deviceName: "Yuka-test", deviceType: 3});
  assert.equal(yuka.route.get(15)[0][5], 12);
});

test("LUBA 2 start still uses the autonomous task controller", () => {
  const envelope = decode(new Methods().buildTaskControlCommand({action: 1, target: {iotId: "test", deviceType: 2}, userAccount: 42}));
  assert.equal(envelope.get(3)[0], 17n);
  assert.equal(envelope.has(12), false, "Must not send manual blade control");
  const task = decode(decode(envelope.get(11)[0]).get(37)[0]);
  assert.equal(task.get(1)[0], 1n);
  assert.equal(task.get(2)[0], 1n);
});
