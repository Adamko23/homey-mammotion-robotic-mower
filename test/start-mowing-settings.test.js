"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeStartMowingSettings,
} = require("../.homeybuild/lib/mammotionStartMowing");
const flowCards = require("../drivers/mower/driver.flow.compose.json");

const validArgs = {
  area_selector: {
    hash: "9098484200456229175",
    id: "9098484200456229175",
    name: "Zone 1",
  },
  blade_height: 50,
  border_laps: "2",
  channel_mode: "1",
  cutting_path_angle: 45,
  cutting_path_angle_mode: "2",
  mow_order: "1",
  obstacle_detection: "10",
  obstacle_laps: "1",
  path_spacing: 20,
  speed: 0.5,
};

const areaHashes = [9098484200456229175n];

test("Start mowing angle labels match Mammotion protocol values", () => {
  const startMowing = flowCards.actions.find((card) => card.id === "start_mowing");
  const angleArgument = startMowing.args.find((argument) => argument.name === "cutting_path_angle_mode");
  const labelsById = Object.fromEntries(
    angleArgument.values.map((value) => [value.id, value.title.en]),
  );

  assert.deepEqual(labelsById, {
    0: "Optimal",
    1: "North (0 deg)",
    2: "Random",
  });
});

test("standard Start mowing preserves random mode and defaults to optimal", () => {
  const random = normalizeStartMowingSettings(validArgs, areaHashes, {
    defaultCuttingPathAngleMode: 0,
  });
  const optimal = normalizeStartMowingSettings({
    ...validArgs,
    cutting_path_angle_mode: undefined,
  }, areaHashes, {
    defaultCuttingPathAngleMode: 0,
  });

  assert.equal(random.cuttingPathAngleMode, 2);
  assert.equal(optimal.cuttingPathAngleMode, 0);
});

test("custom-angle Start mowing forces absolute angle mode", () => {
  const settings = normalizeStartMowingSettings(validArgs, areaHashes, {
    cuttingPathAngleMode: 1,
  });

  assert.equal(settings.cuttingPathAngle, 45);
  assert.equal(settings.cuttingPathAngleMode, 1);
});

test("Start mowing rejects stale values outside supported ranges", () => {
  assert.throws(
    () => normalizeStartMowingSettings({ ...validArgs, speed: 0.8 }, areaHashes),
    /Speed must be between 0\.2 and 0\.6/,
  );
  assert.throws(
    () => normalizeStartMowingSettings({ ...validArgs, obstacle_detection: "2" }, areaHashes),
    /Obstacle detection must be one of: 0, 10, 11/,
  );
  assert.throws(
    () => normalizeStartMowingSettings({ ...validArgs, border_laps: "5" }, areaHashes),
    /Border laps must be between 0 and 4/,
  );
});
