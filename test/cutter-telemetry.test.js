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

test("proto3 omitted RPM is zero, so stopped blades replace an old positive reading", () => {
  for (const hex of ["200262027200", "200352039a0400"]) {
    // driver.14 or sys.67 is present but empty.
    assert.equal(parse(hex).cutterRpm, 0);
  }
  // sys.report_data(39).cutter_work_mode_info(12) is present but empty.
  assert.equal(parse("20035205ba02026200").cutterRpm, 0);
});

test("reflected query, failed query and unrelated telemetry cannot create zero RPM", () => {
  assert.equal(parse("200162027200"), null);
  assert.equal(parse("2002620472021801"), null);
  assert.equal(parse("200362021200"), null);
  const battery = parse("200352040a02084b");
  assert.equal(battery.batteryPercent, 75);
  assert.equal(battery.cutterRpm, undefined);
});
