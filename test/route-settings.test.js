"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  toRouteBorderMode,
  toRouteIncludedAngle,
} = require("../.homeybuild/lib/DNAngelXMammotionMethods");

test("Mammotion path order keeps perimeter first and grid first distinct", () => {
  assert.equal(toRouteBorderMode(0), 0, "Perimeter first must use border mode 0");
  assert.equal(toRouteBorderMode(1), 1, "Grid first must use border mode 1");
});

test("invalid path order falls back to perimeter first", () => {
  assert.equal(toRouteBorderMode(-1), 0);
  assert.equal(toRouteBorderMode(2), 0);
});

test("double grid uses a 90 degree crossing angle", () => {
  assert.equal(toRouteIncludedAngle(0), 0);
  assert.equal(toRouteIncludedAngle(1), 90);
  assert.equal(toRouteIncludedAngle(2), 0);
  assert.equal(toRouteIncludedAngle(3), 0);
});
