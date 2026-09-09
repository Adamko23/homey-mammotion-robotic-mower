"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const { decode, fieldVarint: fv, fieldBytes: fb, navEnvelope } = require("./helpers/protobuf");

const originalLoad = Module._load;
let Client;
try {
  Module._load = function (request, ...args) {
    if (request === "homey") return { env: {} };
    if (request === "homey-oauth2app") return { OAuth2Client: class {}, OAuth2Token: class {}, OAuth2Error: Error };
    return originalLoad.call(this, request, ...args);
  };
  Client = require("../.homeybuild/lib/MammotionOAuth2Client").default;
} finally {
  Module._load = originalLoad;
}
const target = { iotId: "fixture-mower", deviceName: "Luba-VS123456" };
const settings = { areaHashes: [123n], bladeHeight: 45, borderLaps: 2, channelMode: 1, channelWidth: 20,
  cuttingPathAngle: 0, cuttingPathAngleMode: 2, mowOrder: 0, obstacleDetection: 0, obstacleLaps: 0, speed: 0.3, startProgress: 0 };
const routeAck = (height = 45) => navEnvelope(34, fv(7, height));
const taskAck = (result = 0) => navEnvelope(57, Buffer.concat([fv(1, 1), fv(2, 1), fv(3, result), fv(4, 13)]));
const planAck = (id, result = 0) => navEnvelope(53, Buffer.concat([fv(1, 1), fb(2, Buffer.from(id)), fv(4, result)]));
const tickMicrotasks = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 8, 9, 12) });
  const client = new Client();
  client.ensureMqttForTarget = async () => {};
  client.syncMqttTransport = async () => {};
  client.log = () => {};
  client.error = (...args) => assert.fail(args.join(" "));
  client.getUserAccountSubtype = () => 42;
  return client;
}

test("fresh mowing telemetry confirms start even when RPC only returns ok", async (t) => {
  const client = fixture(t), commands = [];
  client.postDeviceCommand = async ({ type }) => {
    commands.push(type);
    if (type === "generate_route") return JSON.stringify({ params: JSON.stringify({ content: routeAck() }) });
    // The real inline JSON telemetry path, not a synthetic command ACK.
    client.processMqttSyncResult(target, JSON.stringify({ params: { items: { deviceState: { value: 13 } } } }));
    return "ok";
  };
  await client.startMowing({ settings, target });
  assert.deepEqual(commands, ["generate_route", "start_task"]);
  assert.equal(client.mowingCommandAckWaitersByKey.size, 0);
  assert.equal(client.mowingStartsInFlight.size, 0);
});

test("modern task-control ACK confirms start without any route-progress event", async (t) => {
  const client = fixture(t);
  client.postDeviceCommand = async ({ type }) => type === "generate_route" ? routeAck() : taskAck();
  await client.startMowing({ settings, target });
});

test("wrong confirmed route height prevents start instead of forcing blades", async (t) => {
  const client = fixture(t), commands = [];
  client.postDeviceCommand = async ({ type }) => { commands.push(type); return routeAck(70); };
  await assert.rejects(client.startMowing({ settings, target }), /70 mm instead of 45 mm/);
  assert.deepEqual(commands, ["generate_route"]);
  assert.equal(client.mowingStartsInFlight.size, 0);
});

test("explicit mower rejection is preserved", async (t) => {
  const client = fixture(t);
  client.postDeviceCommand = async ({ type }) => type === "generate_route" ? routeAck() : taskAck(7);
  await assert.rejects(client.startMowing({ settings, target }), /rejected start \(code 7\)/);
});

test("a saved disabled plan is executed by ID without regenerating or enabling it", async (t) => {
  const client = fixture(t), commands = [];
  client.postDeviceCommand = async ({ type, payload }) => {
    commands.push(type);
    const envelope = decode(payload);
    assert.equal(envelope.get(3)[0], 17n, "LUBA 2 must use the NAV controller");
    const nav = decode(envelope.get(11)[0]);
    assert.deepEqual([...nav.keys()], [53], "No plan edit/enable, new route or manual blade control");
    const plan = decode(nav.get(53)[0]);
    assert.equal(plan.get(1)[0], 1n);
    assert.equal(plan.get(2)[0].toString(), "stored-task-id");
    return planAck("stored-task-id");
  };
  await client.executeSchedule({ target, planId: "stored-task-id" });
  assert.deepEqual(commands, ["execute_schedule"]);
});

test("saved-plan execution also accepts fresh mowing telemetry", async (t) => {
  const client = fixture(t);
  client.postDeviceCommand = async () => {
    client.emitTelemetry(target.iotId, { online: true, receivedAt: Date.now(), stateCode: 13 });
    return "ok";
  };
  await client.executeSchedule({ target, planId: "stored-task-id" });
});

test("a saved-plan rejection remains an error and is not retried", async (t) => {
  const client = fixture(t);
  let calls = 0;
  client.postDeviceCommand = async () => { calls++; return planAck("stored-task-id", 7); };
  await assert.rejects(client.executeSchedule({ target, planId: "stored-task-id" }), /rejected saved task \(code 7\)/);
  assert.equal(calls, 1);
  assert.equal(client.mowingStartsInFlight.size, 0);
});

test("an ACK for a different saved plan cannot confirm this request", async (t) => {
  const client = fixture(t);
  client.postDeviceCommand = async () => planAck("different-plan");
  const rejected = assert.rejects(client.executeSchedule({ target, planId: "stored-task-id" }), /not confirmed/);
  await tickMicrotasks();
  t.mock.timers.tick(20_000);
  await rejected;
  assert.equal(client.mowingCommandAckWaitersByKey.size, 0);
});

test("an unconfirmed start times out without retrying any physical command", async (t) => {
  const client = fixture(t), commands = [];
  client.postDeviceCommand = async ({ type }) => {
    commands.push(type);
    return type === "generate_route" ? routeAck() : "ok";
  };
  const rejected = assert.rejects(client.startMowing({ settings, target }), /not confirmed/);
  await tickMicrotasks();
  t.mock.timers.tick(20_000);
  await rejected;
  assert.deepEqual(commands, ["generate_route", "start_task"]);
});

test("stale, other-device and already-mowing reports cannot confirm a new start", async (t) => {
  const client = fixture(t);
  const pending = client.createMowingCommandAckWaiter({ acknowledgement: "task_started", iotId: target.iotId, expectedPathHash: "new-path" });
  client.emitTelemetry("other-device", { online: true, receivedAt: Date.now(), stateCode: 13 });
  client.emitTelemetry(target.iotId, { online: true, receivedAt: Date.now() - 1, stateCode: 13 });
  client.emitTelemetry(target.iotId, { online: true, receivedAt: Date.now(), stateCode: 13, pathHash: "old-path" });
  t.mock.timers.tick(20_000);
  assert.equal((await pending.promise).confirmed, false);
  const alreadyMowing = client.createMowingCommandAckWaiter({ acknowledgement: "schedule_started", iotId: target.iotId });
  client.emitTelemetry(target.iotId, { online: true, receivedAt: Date.now(), stateCode: 13 });
  t.mock.timers.tick(20_000);
  assert.equal((await alreadyMowing.promise).confirmed, false);
});

test("gateway timeout after confirmed execution is success, without retransmission", async (t) => {
  const client = fixture(t);
  client.getToken = () => ({ access_token: `unused.${Buffer.from(JSON.stringify({ iot: "iot.mammotion.com" })).toString("base64url")}.unused` });
  let calls = 0;
  client.post = async () => {
    calls++;
    client.emitTelemetry(target.iotId, { online: true, receivedAt: Date.now(), stateCode: 13 });
    return { code: 20056 };
  };
  await client.executeSchedule({ target, planId: "stored-task-id" });
  assert.equal(calls, 1);
});

test("authentication errors are not hidden by telemetry", async (t) => {
  const client = fixture(t);
  client.postDeviceCommand = async () => {
    client.emitTelemetry(target.iotId, { online: true, receivedAt: Date.now(), stateCode: 13 });
    throw new Error("401 unauthorized");
  };
  await assert.rejects(client.executeSchedule({ target, planId: "stored-task-id" }), /401 unauthorized/);
});

test("retained status does not confirm a newly sent command", async (t) => {
  const client = fixture(t);
  const waiter = client.createMowingCommandAckWaiter({ acknowledgement: "task_started", iotId: target.iotId });
  client.getMqttTargetForTopic = () => target;
  client.handleMqttMessage("fixture-topic", Buffer.from(JSON.stringify({ params: { items: { deviceState: { value: 13 } } } })), true);
  t.mock.timers.tick(20_000);
  assert.equal((await waiter.promise).confirmed, false);
});

test("concurrent starts cannot overwrite the route or share an acknowledgement", async (t) => {
  const client = fixture(t);
  client.postDeviceCommand = async () => "ok";
  const first = client.executeSchedule({ target, planId: "stored-task-id" });
  await assert.rejects(client.startMowing({ settings, target }), /already in progress/);
  await tickMicrotasks();
  client.resolveMowingCommandAcknowledgements(target.iotId, planAck("stored-task-id"));
  await first;
});
