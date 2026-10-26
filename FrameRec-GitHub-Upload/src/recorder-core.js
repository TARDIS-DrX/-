const BITRATES = {
  compact: 2_500_000,
  standard: 5_000_000,
  high: 8_000_000,
};

const SUPPORTED_FRAME_RATES = new Set([30, 60, 120]);

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pair = (value) => String(value).padStart(2, "0");

  if (hours > 0) {
    return `${pair(hours)}:${pair(minutes)}:${pair(seconds)}`;
  }

  return `${pair(minutes)}:${pair(seconds)}`;
}

export function pickMimeType(candidates, isSupported) {
  return candidates.find((type) => isSupported(type)) ?? "";
}

export function buildRecordingName(date = new Date()) {
  const pair = (value) => String(value).padStart(2, "0");
  const stamp = [
    date.getFullYear(),
    pair(date.getMonth() + 1),
    pair(date.getDate()),
    pair(date.getHours()),
    pair(date.getMinutes()),
    pair(date.getSeconds()),
  ].join("-");

  return `FrameRec-${stamp}.webm`;
}

export function normalizeFrameRate(frameRate) {
  const numericFrameRate = Number(frameRate);
  return SUPPORTED_FRAME_RATES.has(numericFrameRate) ? numericFrameRate : 30;
}

export function getVideoBitrate(quality, frameRate = 60) {
  const baseBitrate = BITRATES[quality] ?? BITRATES.standard;
  return normalizeFrameRate(frameRate) === 120 ? baseBitrate * 2 : baseBitrate;
}

export function formatBytes(bytes) {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;

  return unitIndex === 0
    ? `${Math.round(value)} ${units[unitIndex]}`
    : `${value.toFixed(1)} ${units[unitIndex]}`;
}
