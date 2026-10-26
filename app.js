import {
  buildRecordingName,
  formatBytes,
  formatDuration,
  getVideoBitrate,
  normalizeFrameRate,
  pickMimeType,
} from "./src/recorder-core.js";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

const QUALITY_LABELS = {
  compact: "省空间",
  standard: "均衡",
  high: "高清",
};

const STATUS_LABELS = {
  idle: "待机",
  requesting: "准备中",
  recording: "录制中",
  paused: "已暂停",
  processing: "保存中",
  ready: "已完成",
  error: "需要处理",
};

const elements = {
  statusPill: document.querySelector("#status-pill"),
  statusLabel: document.querySelector("#status-label"),
  stageSubtitle: document.querySelector("#stage-subtitle"),
  monitor: document.querySelector("#monitor"),
  monitorMode: document.querySelector("#monitor-mode"),
  monitorTime: document.querySelector("#monitor-time"),
  preview: document.querySelector("#preview"),
  resolutionMeta: document.querySelector("#resolution-meta"),
  fpsMeta: document.querySelector("#fps-meta"),
  codecMeta: document.querySelector("#codec-meta"),
  resultStrip: document.querySelector("#result-strip"),
  resultDuration: document.querySelector("#result-duration"),
  resultSize: document.querySelector("#result-size"),
  resultResolution: document.querySelector("#result-resolution"),
  settingsFieldset: document.querySelector("#settings-fieldset"),
  fpsHint: document.querySelector("#fps-hint"),
  qualityHint: document.querySelector("#quality-hint"),
  micToggle: document.querySelector("#mic-toggle"),
  audioToggle: document.querySelector("#audio-toggle"),
  startButton: document.querySelector("#start-button"),
  startButtonLabel: document.querySelector("#start-button-label"),
  activeActions: document.querySelector("#active-actions"),
  pauseButton: document.querySelector("#pause-button"),
  pauseButtonLabel: document.querySelector("#pause-button-label"),
  pauseIcon: document.querySelector(".icon-pause"),
  playIcon: document.querySelector(".icon-play"),
  stopButton: document.querySelector("#stop-button"),
  statusMessage: document.querySelector("#status-message"),
  downloadButton: document.querySelector("#download-button"),
  recordAgainButton: document.querySelector("#record-again-button"),
};

let state = "idle";
let displayStream = null;
let micStream = null;
let recordingStream = null;
let audioContext = null;
let mediaRecorder = null;
let chunks = [];
let stopping = false;
let recordedBlob = null;
let recordingUrl = "";
let recordingName = "";
let recordedResolution = "";
let elapsedBeforeSegment = 0;
let segmentStartedAt = null;
let timerId = null;
let startedAt = null;
let selectedMimeType = "";

function getSelectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
}

function getSettings() {
  return {
    fps: normalizeFrameRate(getSelectedValue("fps") || 30),
    quality: getSelectedValue("quality") || "standard",
    microphone: elements.micToggle.checked,
    systemAudio: elements.audioToggle.checked,
  };
}

function setState(nextState) {
  state = nextState;
  document.body.dataset.recorderState = nextState;
  elements.statusLabel.textContent = STATUS_LABELS[nextState] ?? nextState;
  updateControls();
}

function setMessage(text, tone = "") {
  elements.statusMessage.textContent = text;
  if (tone) {
    elements.statusMessage.dataset.tone = tone;
  } else {
    delete elements.statusMessage.dataset.tone;
  }
}

function setSubtitle(text) {
  elements.stageSubtitle.textContent = text;
}

function updateControls() {
  const active = state === "recording" || state === "paused";
  const busy = active || state === "requesting" || state === "processing";
  const canRecord = Boolean(
    navigator.mediaDevices?.getDisplayMedia &&
    window.MediaRecorder &&
    window.isSecureContext,
  );

  elements.settingsFieldset
    .querySelectorAll("input")
    .forEach((input) => {
      input.disabled = busy;
    });

  elements.startButton.hidden = active;
  elements.startButton.disabled = busy || !canRecord;
  elements.activeActions.hidden = !active;
  elements.resultStrip.hidden = state !== "ready";

  if (state === "requesting") {
    elements.startButtonLabel.textContent = "正在准备";
  } else if (state === "processing") {
    elements.startButtonLabel.textContent = "正在保存";
  } else if (state === "ready") {
    elements.startButtonLabel.textContent = "开始新录制";
  } else {
    elements.startButtonLabel.textContent = "开始录制";
  }

  const paused = state === "paused";
  elements.pauseButtonLabel.textContent = paused ? "继续" : "暂停";
  elements.pauseIcon.hidden = paused;
  elements.playIcon.hidden = !paused;
  elements.stopButton.disabled = state === "processing";
}

function updateTimer() {
  elements.monitorTime.textContent = formatDuration(getElapsedMs());
}

function getElapsedMs() {
  const currentSegment = segmentStartedAt === null
    ? 0
    : performance.now() - segmentStartedAt;
  return elapsedBeforeSegment + currentSegment;
}

function startTimer() {
  stopTimer();
  timerId = window.setInterval(updateTimer, 200);
  updateTimer();
}

function stopTimer() {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }

  updateTimer();
}

function getDisplayConstraints(settings) {
  return {
    video: {
      frameRate: { ideal: settings.fps, max: settings.fps },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      cursor: "always",
      displaySurface: "monitor",
    },
    audio: settings.systemAudio,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: settings.systemAudio ? "include" : "exclude",
    monitorTypeSurfaces: "include",
  };
}

async function requestMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

async function mixAudioTracks(systemStream, microphoneStream) {
  const videoTracks = systemStream.getVideoTracks();
  const systemAudioTracks = systemStream.getAudioTracks();
  const microphoneTracks = microphoneStream?.getAudioTracks() ?? [];
  const audioTracks = [...systemAudioTracks, ...microphoneTracks];

  if (audioTracks.length === 0) {
    return new MediaStream(videoTracks);
  }

  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) {
    return new MediaStream([...videoTracks, ...audioTracks]);
  }

  audioContext = new AudioContextClass();
  const destination = audioContext.createMediaStreamDestination();

  for (const track of systemAudioTracks) {
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    gain.gain.value = 0.95;
    source.connect(gain).connect(destination);
  }

  for (const track of microphoneTracks) {
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return new MediaStream([
    ...videoTracks,
    ...destination.stream.getAudioTracks(),
  ]);
}

function getRecorderOptions(settings) {
  const options = {
    videoBitsPerSecond: getVideoBitrate(settings.quality, settings.fps),
    audioBitsPerSecond: 128_000,
  };

  selectedMimeType = pickMimeType(
    MIME_CANDIDATES,
    (type) => window.MediaRecorder.isTypeSupported(type),
  );

  if (selectedMimeType) {
    options.mimeType = selectedMimeType;
  }

  return options;
}

function updateCodecLabel() {
  if (selectedMimeType.includes("vp9")) {
    elements.codecMeta.textContent = "VP9 / WEBM";
  } else if (selectedMimeType.includes("vp8")) {
    elements.codecMeta.textContent = "VP8 / WEBM";
  } else {
    elements.codecMeta.textContent = "WEBM";
  }
}

function updatePreviewMetadata() {
  const track = displayStream?.getVideoTracks()[0];
  if (!track) {
    return;
  }

  const settings = track.getSettings();
  const width = settings.width || elements.preview.videoWidth;
  const height = settings.height || elements.preview.videoHeight;
  const fps = Math.round(settings.frameRate || getSettings().fps);

  if (width && height) {
    recordedResolution = `${width} × ${height}`;
    elements.resolutionMeta.textContent = recordedResolution;
  }

  elements.fpsMeta.textContent = `${fps} FPS`;
}

function attachDisplayEvents(stream) {
  const videoTrack = stream.getVideoTracks()[0];
  videoTrack?.addEventListener(
    "ended",
    () => {
      if (state === "recording" || state === "paused") {
        setMessage("屏幕共享已结束，正在保存当前录像。", "warning");
        stopRecording();
      }
    },
    { once: true },
  );
}

function clearExistingOutput() {
  if (recordingUrl) {
    URL.revokeObjectURL(recordingUrl);
    recordingUrl = "";
  }

  recordedBlob = null;
  elements.preview.pause();
  elements.preview.src = "";
  elements.preview.srcObject = null;
  elements.preview.controls = false;
  elements.preview.muted = true;
}

function resetResult() {
  clearExistingOutput();
  elements.resultStrip.hidden = true;
  elements.monitorMode.textContent = "PREVIEW";
  elements.resolutionMeta.textContent = "-- × --";
  elements.fpsMeta.textContent = `${getSettings().fps} FPS`;
  elements.monitorTime.textContent = "00:00";
  elapsedBeforeSegment = 0;
  segmentStartedAt = null;
  startedAt = null;
}

async function startRecording() {
  if (state === "requesting" || state === "recording" || state === "paused") {
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    setState("error");
    setMessage("当前浏览器不支持屏幕录制。请使用最新版 Chrome 或 Edge。", "error");
    return;
  }

  if (!window.isSecureContext) {
    setState("error");
    setMessage("请在本地启动器打开的页面中使用录屏功能。", "error");
    return;
  }

  resetResult();
  setState("requesting");
  setSubtitle("正在请求录制权限");
  setMessage("请在浏览器提示中选择要共享的画面。");

  const settings = getSettings();
  const warnings = [];

  try {
    if (settings.microphone) {
      try {
        micStream = await requestMicrophone();
      } catch (error) {
        if (error.name === "NotAllowedError") {
          warnings.push("未获得麦克风权限，将只录制画面");
        } else if (error.name === "NotReadableError") {
          warnings.push("麦克风正被其他程序占用，将只录制画面");
        } else {
          warnings.push("麦克风暂时不可用，将只录制画面");
        }
      }
    }

    displayStream = await navigator.mediaDevices.getDisplayMedia(
      getDisplayConstraints(settings),
    );

    if (settings.systemAudio && displayStream.getAudioTracks().length === 0) {
      warnings.push("所选画面没有可录制的声音");
    }

    recordingStream = await mixAudioTracks(displayStream, micStream);
    mediaRecorder = new MediaRecorder(recordingStream, getRecorderOptions(settings));
    chunks = [];
    stopping = false;

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("error", (event) => {
      console.error("MediaRecorder error", event.error);
      setMessage("编码器遇到错误，正在保存已有内容。", "error");
      stopRecording();
    });

    mediaRecorder.addEventListener("stop", finalizeRecording, { once: true });

    elements.preview.src = "";
    elements.preview.srcObject = displayStream;
    elements.preview.muted = true;
    elements.preview.controls = false;
    await elements.preview.play().catch(() => {});

    attachDisplayEvents(displayStream);
    updatePreviewMetadata();
    updateCodecLabel();

    mediaRecorder.start(1000);
    startedAt = new Date();
    elapsedBeforeSegment = 0;
    segmentStartedAt = performance.now();
    startTimer();

    elements.monitorMode.textContent = "REC";
    setState("recording");
    setSubtitle("实时画面 · 本地编码");

    if (warnings.length > 0) {
      setMessage(`${warnings.join("；")}。`, "warning");
    } else {
      setMessage("正在录制，画面与音频只在本机处理。", "success");
    }
  } catch (error) {
    console.error("Unable to start recording", error);
    await cleanupMediaResources();
    resetResult();
    setState("error");
    setSubtitle("未能接入录制画面");

    if (error.name === "NotAllowedError") {
      setMessage("未获得屏幕共享权限。重新开始并允许共享即可。", "error");
    } else if (error.name === "NotFoundError") {
      setMessage("没有找到可共享的画面。请确认屏幕或窗口可用。", "error");
    } else if (error.name === "NotSupportedError") {
      setMessage("当前浏览器不支持所需录制格式。请使用最新版 Chrome 或 Edge。", "error");
    } else {
      setMessage("无法开始录制。请检查浏览器权限后重试。", "error");
    }
  }
}

function pauseRecording() {
  if (state === "recording" && mediaRecorder?.state === "recording") {
    mediaRecorder.pause();
    elapsedBeforeSegment += performance.now() - segmentStartedAt;
    segmentStartedAt = null;
    stopTimer();
    setState("paused");
    elements.monitorMode.textContent = "PAUSE";
    setSubtitle("画面已暂停");
    setMessage("录制已暂停，继续后会写入同一个文件。", "warning");
  } else if (state === "paused" && mediaRecorder?.state === "paused") {
    mediaRecorder.resume();
    segmentStartedAt = performance.now();
    startTimer();
    setState("recording");
    elements.monitorMode.textContent = "REC";
    setSubtitle("实时画面 · 本地编码");
    setMessage("正在继续录制。", "success");
  }
}

function stopRecording() {
  if (
    stopping ||
    !mediaRecorder ||
    (mediaRecorder.state !== "recording" && mediaRecorder.state !== "paused")
  ) {
    return;
  }

  stopping = true;
  if (segmentStartedAt !== null) {
    elapsedBeforeSegment += performance.now() - segmentStartedAt;
    segmentStartedAt = null;
  }

  stopTimer();
  setState("processing");
  elements.startButton.hidden = false;
  setSubtitle("正在封装录像文件");
  setMessage("正在保存录制内容。");
  mediaRecorder.stop();
}

async function finalizeRecording() {
  const durationMs = getElapsedMs();
  const type = selectedMimeType || "video/webm";
  recordedBlob = new Blob(chunks, { type });
  chunks = [];

  await cleanupMediaResources();

  if (recordedBlob.size === 0) {
    setState("error");
    setSubtitle("录像内容为空");
    setMessage("没有生成可保存的录制内容，请重新录制。", "error");
    return;
  }

  if (recordingUrl) {
    URL.revokeObjectURL(recordingUrl);
  }

  recordingUrl = URL.createObjectURL(recordedBlob);
  recordingName = buildRecordingName(startedAt ?? new Date());

  elements.preview.srcObject = null;
  elements.preview.src = recordingUrl;
  elements.preview.muted = false;
  elements.preview.controls = true;
  await elements.preview.play().catch(() => {});

  elements.monitorMode.textContent = "REVIEW";
  elements.monitorTime.textContent = formatDuration(durationMs);
  elements.resultDuration.textContent = formatDuration(durationMs);
  elements.resultSize.textContent = formatBytes(recordedBlob.size);
  elements.resultResolution.textContent = recordedResolution || "-- × --";
  setState("ready");
  setSubtitle("预览录像 · 可下载");
  setMessage("录制已完成，录像只保存在当前浏览器中。", "success");
}

async function cleanupMediaResources() {
  const streams = [displayStream, micStream, recordingStream];
  displayStream = null;
  micStream = null;
  recordingStream = null;

  for (const stream of streams) {
    if (!stream) {
      continue;
    }

    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  if (audioContext) {
    const context = audioContext;
    audioContext = null;
    await context.close().catch(() => {});
  }

  elements.preview.srcObject = null;
  stopping = false;
}

function downloadRecording() {
  if (!recordingUrl) {
    return;
  }

  const link = document.createElement("a");
  link.href = recordingUrl;
  link.download = recordingName || buildRecordingName(new Date());
  document.body.append(link);
  link.click();
  link.remove();
}

function updateSettingHints() {
  const settings = getSettings();
  elements.fpsHint.textContent = `${settings.fps} FPS`;
  elements.qualityHint.textContent = QUALITY_LABELS[settings.quality];

  if (state === "idle" || state === "error") {
    elements.fpsMeta.textContent = `${settings.fps} FPS`;
  }
}

function handleKeydown(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  if (event.code === "KeyR") {
    event.preventDefault();
    if (state === "recording" || state === "paused") {
      stopRecording();
    } else if (state !== "requesting" && state !== "processing") {
      startRecording();
    }
  }

  if (event.code === "KeyP" && (state === "recording" || state === "paused")) {
    event.preventDefault();
    pauseRecording();
  }
}

function handleBeforeUnload(event) {
  if (state === "recording" || state === "paused" || state === "processing") {
    event.preventDefault();
    event.returnValue = "";
  }
}

function initialize() {
  const supported = Boolean(
    navigator.mediaDevices?.getDisplayMedia &&
    window.MediaRecorder &&
    window.isSecureContext,
  );

  if (!supported) {
    setState("error");
    setMessage("当前环境不支持录屏。请用最新版 Chrome 或 Edge 打开本地启动器。", "error");
    return;
  }

  setState("idle");
  updateSettingHints();
  elements.fpsMeta.textContent = `${getSettings().fps} FPS`;

  elements.startButton.addEventListener("click", startRecording);
  elements.pauseButton.addEventListener("click", pauseRecording);
  elements.stopButton.addEventListener("click", stopRecording);
  elements.downloadButton.addEventListener("click", downloadRecording);
  elements.recordAgainButton.addEventListener("click", startRecording);

  document
    .querySelectorAll('input[name="fps"], input[name="quality"]')
    .forEach((input) => input.addEventListener("change", updateSettingHints));

  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("beforeunload", handleBeforeUnload);
}

initialize();
