"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decode } = require("./helpers/protobuf");
const Methods = require("../.homeybuild/lib/DNAngelXMammotionMethods").default;
const parse = (hex) => new Methods().parseTelemetry(Buffer.from(hex, "hex").toString("base64"));

test("read-only cutter query contains no blade or movement control", () => {
  const envelope = decode(new Methods().buildGetCutterStatusCommand({userAccount: 42}));
  assert.equal(envelope.get(1)[0], 243n);
  assert.equal(envelope.get(3)[0], 1n);
  assert.equal(envelope.get(4)[0], 1n);
  const driver = decode(envelope.get(12)[0]);
  assert.deepEqual([...driver.keys()], [14]);
  assert.equal(driver.get(14)[0].length, 0);
});

test("driver cutter response decodes actual RPM independently of the speed preset", () => {
  // LubaMsg.driver(12).current_cutter_mode(14): mode=2, rpm=3036.
  const telemetry = parse("200262077205080210dc17");
  assert.equal(telemetry.cutterMode, 2);
  assert.equal(telemetry.cutterRpm, 3036);
  assert.ok(telemetry.receivedAt > 0);
});

test("empty cutter blocks are not measured zero RPM", () => {
  for (const hex of ["200262027200", "200352039a0400", "20035205ba02026200"]) {
    // Empty driver.14, sys.67, or sys.report.12 is not an RPM reading.
    assert.equal(parse(hex), null);
  }
  // A mode preset without RPM does not establish blade rotation either.
  assert.equal(parse("2002620472020802").cutterRpm, undefined);
});

test("explicit zero RPM remains a valid measurement", () => {
  for (const hex of ["2002620472021000", "200352059a04021000", "20035207ba020462021000"]) {
    assert.equal(parse(hex).cutterRpm, 0);
  }
});

test("reflected query, failed query and unrelated telemetry cannot create zero RPM", () => {
  assert.equal(parse("200162027200"), null);
  assert.equal(parse("2002620472021801"), null);
  assert.equal(parse("200362021200"), null);
  const battery = parse("200352040a02084b");
  assert.equal(battery.batteryPercent, 75);
  assert.equal(battery.cutterRpm, undefined);
});
