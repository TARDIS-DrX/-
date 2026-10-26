import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecordingName,
  formatBytes,
  formatDuration,
  getVideoBitrate,
  normalizeFrameRate,
  pickMimeType,
} from "../src/recorder-core.js";

test("formatBytes uses readable binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("formatDuration shows minutes and seconds", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(65_000), "01:05");
});

test("formatDuration adds hours after one hour", () => {
  assert.equal(formatDuration(3_661_000), "01:01:01");
});

test("pickMimeType uses the first supported codec", () => {
  const supported = new Set(["video/webm;codecs=vp8"]);
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  assert.equal(pickMimeType(candidates, (type) => supported.has(type)), "video/webm;codecs=vp8");
});

test("pickMimeType returns an empty string when no codec is supported", () => {
  assert.equal(pickMimeType(["video/webm;codecs=vp9"], () => false), "");
});

test("buildRecordingName creates a sortable WebM filename", () => {
  const date = new Date(2026, 9, 25, 14, 8, 9);
  assert.equal(buildRecordingName(date), "FrameRec-2026-10-25-14-08-09.webm");
});

test("getVideoBitrate maps quality presets to bitrates", () => {
  assert.equal(getVideoBitrate("compact"), 2_500_000);
  assert.equal(getVideoBitrate("standard"), 5_000_000);
  assert.equal(getVideoBitrate("high"), 8_000_000);
});

test("normalizeFrameRate accepts only supported recording frame rates", () => {
  assert.equal(normalizeFrameRate(30), 30);
  assert.equal(normalizeFrameRate(60), 60);
  assert.equal(normalizeFrameRate(120), 120);
  assert.equal(normalizeFrameRate(75), 30);
});

test("getVideoBitrate raises the bitrate for 120 FPS", () => {
  assert.equal(getVideoBitrate("standard", 120), 10_000_000);
  assert.equal(getVideoBitrate("high", 120), 16_000_000);
});
