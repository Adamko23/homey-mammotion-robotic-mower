"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { decode, fieldVarint: fv, fieldBytes: fb, navEnvelope } = require("./helpers/protobuf");
const Methods = require("../.homeybuild/lib/DNAngelXMammotionMethods").default;

test("route query is read-only and never sends height, zones, start or plan enable", () => {
  const query = new Methods().buildQueryRouteCommand({ target: { iotId: "fixture", deviceName: "Luba-VS123456" }, userAccount: 42 });
  const envelope = decode(query);
  assert.equal(envelope.get(3)[0], 17n);
  assert.equal(envelope.get(4)[0], 1n);
  const nav = decode(envelope.get(11)[0]);
  assert.deepEqual([...nav.keys()], [34]);
  const route = decode(nav.get(34)[0]);
  assert.deepEqual([...route.entries()], [[1, [1n]], [5, [2n]]]);
});

test("the live report pattern with 70 mm and empty RPM does not replace configured 45 mm", () => {
  const methods = new Methods();
  const configured = methods.parseTelemetry(navEnvelope(34, Buffer.concat([fv(5, 2), fv(7, 45)])));
  assert.equal(configured.taskBladeHeightMm, 45);
  assert.equal(configured.bladeHeightMm, undefined);
  const work = fb(5, fv(20, 70));
  const placeholder = fb(12, Buffer.alloc(0));
  const report = Buffer.concat([fv(2, 1), fb(10, fb(39, Buffer.concat([work, placeholder])))]).toString("base64");
  const actual = methods.parseTelemetry(report);
  assert.equal(actual.bladeHeightMm, 70);
  assert.equal(actual.taskBladeHeightMm, undefined);
  assert.equal(actual.cutterRpm, undefined);
});

test("reflected or rejected route settings cannot become confirmed task height", () => {
  const methods = new Methods();
  assert.equal(methods.parseTelemetry(navEnvelope(34, fv(7, 45), 1)), null);
  assert.equal(methods.parseTelemetry(navEnvelope(34, Buffer.concat([fv(7, 45), fv(16, 7)]))), null);
});

test("direct driver height reports are decoded without treating a write as telemetry", () => {
  const methods = new Methods();
  const report = field => Buffer.concat([fv(2, 1), fv(4, 2), fb(12, fb(field, fv(1, 45)))]).toString("base64");
  assert.equal(methods.parseTelemetry(report(4)).bladeHeightMm, 45);
  assert.equal(methods.parseTelemetry(report(2)), null);
});
