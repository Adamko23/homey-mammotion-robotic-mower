"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const DNAngelXMammotionMethods = require("../.homeybuild/lib/DNAngelXMammotionMethods").default;

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);

  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);

  return Buffer.from(bytes);
}

function fieldBytes(fieldNumber, value) {
  return Buffer.concat([
    varint((BigInt(fieldNumber) << 3n) | 2n),
    varint(value.length),
    value,
  ]);
}

function fieldVarint(fieldNumber, value) {
  return Buffer.concat([
    varint(BigInt(fieldNumber) << 3n),
    varint(value),
  ]);
}

function envelope(nav, messageAttribute = 2) {
  return Buffer.concat([
    fieldVarint(4, messageAttribute),
    fieldBytes(11, nav),
  ]).toString("base64");
}

test("parses successful generated-route confirmation", () => {
  const methods = new DNAngelXMammotionMethods();
  const route = Buffer.concat([
    fieldVarint(5, 0),
    fieldVarint(16, 0),
  ]);

  assert.deepEqual(methods.parseCommandAcknowledgements(envelope(fieldBytes(34, route))), {
    routeConfirmed: true,
    routeResult: 0,
    taskStarted: false,
  });
});

test("preserves a mower route-generation failure result", () => {
  const methods = new DNAngelXMammotionMethods();
  const route = fieldVarint(16, 7);

  assert.deepEqual(methods.parseCommandAcknowledgements(envelope(fieldBytes(34, route))), {
    routeConfirmed: true,
    routeResult: 7,
    taskStarted: false,
  });
});

test("parses the first route-progress frame as mowing started", () => {
  const methods = new DNAngelXMammotionMethods();
  const progress = fieldVarint(4, 1);

  assert.deepEqual(methods.parseCommandAcknowledgements(envelope(fieldBytes(50, progress), 3)), {
    routeConfirmed: false,
    taskStarted: true,
  });
});

test("does not accept a reflected route request as mower confirmation", () => {
  const methods = new DNAngelXMammotionMethods();
  const routeRequest = fieldBytes(34, fieldVarint(7, 45));

  assert.deepEqual(methods.parseCommandAcknowledgements(envelope(routeRequest, 1)), {
    routeConfirmed: false,
    taskStarted: false,
  });
});

test("does not mistake telemetry or malformed input for a command acknowledgement", () => {
  const methods = new DNAngelXMammotionMethods();

  assert.deepEqual(methods.parseCommandAcknowledgements("not-base64!"), {
    routeConfirmed: false,
    taskStarted: false,
  });
  assert.deepEqual(methods.parseCommandAcknowledgements(fieldBytes(10, Buffer.alloc(0)).toString("base64")), {
    routeConfirmed: false,
    taskStarted: false,
  });
});
