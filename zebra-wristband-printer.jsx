import { Component, useState, useRef, useEffect, useCallback } from "react";
import qrcode from "qrcode-generator";

// ── Local print server API ────────────────────────────────────────────────────
const SERVER = "http://localhost:3001";

const PrintAPI = {
  findPrinter: async () => {
    const res = await fetch(`${SERVER}/api/printers`);
    return res.json(); // { suggested, printers, message }
  },
  print: async (printerName, epl) => {
    console.log("[PrintAPI] POST /api/print", {
      printer: printerName,
      bytes: epl.length,
      preview: epl.replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, 500),
    });
    const res = await fetch(`${SERVER}/api/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printer: printerName, eplBase64: btoa(epl) }),
    });
    const data = await res
      .json()
      .catch(() => ({ error: `Print server returned HTTP ${res.status}` }));
    console.log("[PrintAPI] /api/print response", { status: res.status, data });
    if (!res.ok)
      return {
        error: data.error || `Print server returned HTTP ${res.status}`,
      };
    return data; // { ok } or { error }
  },
  clearPrinter: async (printerName) => {
    const res = await fetch(`${SERVER}/api/clear-printer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printer: printerName }),
    });
    const data = await res
      .json()
      .catch(() => ({ error: `Print server returned HTTP ${res.status}` }));
    if (!res.ok)
      return {
        error: data.error || `Print server returned HTTP ${res.status}`,
      };
    return data;
  },
};

const BAND_WIDTH_DOTS = 203;
const PRINTABLE_LENGTH_DOTS = 1358;
const DEFAULT_LABEL_LENGTH_DOTS = 1280.2;
const DEFAULT_MARK_THICKNESS_DOTS = 24;
const DEFAULT_MARK_OFFSET_DOTS = 0;
const WORKING_TEST_EPL =
  `N\r\nD10\r\nS2\r\nq203\r\nQ${DEFAULT_LABEL_LENGTH_DOTS},0\r\nA20,40,0,3,1,1,N,"SERVER TEST"\r\nP1\r\n`;
const CODE39_PATTERNS = {
  0: "nnnwwnwnn",
  1: "wnnwnnnnw",
  2: "nnwwnnnnw",
  3: "wnwwnnnnn",
  4: "nnnwwnnnw",
  5: "wnnwwnnnn",
  6: "nnwwwnnnn",
  7: "nnnwnnwnw",
  8: "wnnwnnwnn",
  9: "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  $: "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[AppErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: "#fecaca",
            fontFamily: "monospace",
            background: "#0a0f1a",
            minHeight: "100vh",
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>App crashed</h1>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── EPL2 builder ─────────────────────────────────────────────────────────────
// Wristband: 28 cm total, 2.5 cm wide, 17 cm printable after black mark
// 203 dpi: 28cm=2238 dots total, 17cm=1358 dots printable, black mark ~24 dots
// EPL2 coords: X across width (0-203), Y along printable length (0-1358)
function canvasToEplGraphic(
  sourceCanvas,
  x,
  y,
  orientation = "horizontal",
  options = {},
) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const sourceCtx = sourceCanvas.getContext("2d");
  const sourcePixels = sourceCtx.getImageData(
    0,
    0,
    sourceWidth,
    sourceHeight,
  ).data;
  const outputWidth = orientation === "horizontal" ? sourceHeight : sourceWidth;
  const outputHeight =
    orientation === "horizontal" ? sourceWidth : sourceHeight;
  const bytesPerRow = Math.ceil(outputWidth / 8);

  let data = "";

  for (let y = 0; y < outputHeight; y++) {
    for (let byteX = 0; byteX < bytesPerRow; byteX++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = byteX * 8 + bit;
        if (x >= outputWidth) {
          if (options.invert) byte |= 1 << (7 - bit);
          continue;
        }

        const sourceX = orientation === "horizontal" ? y : x;
        const sourceY = orientation === "horizontal" ? sourceHeight - 1 - x : y;
        const i = (sourceY * sourceWidth + sourceX) * 4;
        const alpha = sourcePixels[i + 3];
        const luma =
          sourcePixels[i] * 0.299 +
          sourcePixels[i + 1] * 0.587 +
          sourcePixels[i + 2] * 0.114;
        const darkPixel = alpha > 127 && luma < 160;
        const setBit = options.invert ? !darkPixel : darkPixel;
        if (setBit) byte |= 1 << (7 - bit);
      }
      data += String.fromCharCode(byte);
    }
  }

  const eplX = orientation === "horizontal" ? Math.round(y) : Math.round(x);
  const eplY =
    orientation === "horizontal"
      ? Math.round(x + (options.lengthOffset || 0))
      : Math.round(y);
  return `GW${eplX},${eplY},${bytesPerRow},${outputHeight},${data}`;
}

function imageToEplGraphic(
  img,
  el,
  orientation = "horizontal",
  lengthOffset = 0,
  options = {},
) {
  const width = Math.max(1, Math.round(el.w || 80));
  const height = Math.max(1, Math.round(el.h || 40));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  if (options.flipX) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(img, -width, 0, width, height);
    ctx.restore();
  } else {
    ctx.drawImage(img, 0, 0, width, height);
  }

  return canvasToEplGraphic(canvas, el.x, el.y, orientation, {
    lengthOffset,
    invert: options.invert,
  });
}

function normalizeCode39Value(value) {
  return String(value || "")
    .toUpperCase()
    .split("")
    .filter((char) => CODE39_PATTERNS[char] && char !== "*")
    .join("");
}

function code39PatternWidth(value, narrow = 2, wide = 5) {
  return [...`*${normalizeCode39Value(value)}*`].reduce((total, char) => {
    const pattern = CODE39_PATTERNS[char];
    return (
      total +
      pattern
        .split("")
        .reduce((sum, mark) => sum + (mark === "w" ? wide : narrow), 0) +
      narrow
    );
  }, 0);
}

function estimateEplTextAdvance(value, font = 3, hm = 1) {
  const charWidthByFont = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 32 };
  return (
    String(value || "").length *
    (charWidthByFont[font] || 12) *
    Math.max(1, hm || 1)
  );
}

function estimateEplTextHeight(font = 3, vm = 1) {
  const charHeightByFont = { 1: 12, 2: 16, 3: 20, 4: 24, 5: 48 };
  return (charHeightByFont[font] || 20) * Math.max(1, vm || 1);
}

function mapPreviewLengthToPrinterY(
  previewX,
  elementLength = 0,
  printStartOffset = 0,
  printDirection = "opposite",
) {
  if (printDirection === "bookingqube") {
    return Math.max(
      0,
      Math.round(
        PRINTABLE_LENGTH_DOTS -
          previewX -
          elementLength +
          (printStartOffset || 0),
      ),
    );
  }
  return Math.max(0, Math.round(previewX + (printStartOffset || 0)));
}

function drawCode39ToCanvas(ctx, value, x, y, options = {}) {
  const encoded = `*${normalizeCode39Value(value)}*`;
  const narrow = options.narrow || 2;
  const wide = options.wide || 5;
  const barHeight = options.barHeight || 80;
  const textHeight = options.textHeight ?? 18;
  const drawText = options.drawText ?? true;
  let cx = x;

  ctx.fillStyle = "#111";
  for (const char of encoded) {
    const pattern = CODE39_PATTERNS[char];
    for (let i = 0; i < pattern.length; i++) {
      const segmentWidth = pattern[i] === "w" ? wide : narrow;
      if (i % 2 === 0) ctx.fillRect(cx, y, segmentWidth, barHeight);
      cx += segmentWidth;
    }
    cx += narrow;
  }

  if (drawText) {
    ctx.font = "bold 18px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(
      normalizeCode39Value(value),
      x + (cx - x) / 2,
      y + barHeight + 2,
      Math.max(1, cx - x),
    );
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  return { width: cx - x, height: barHeight + (drawText ? textHeight : 0) };
}

function code39ToEplGraphic(el, orientation = "horizontal", lengthOffset = 0) {
  const value = normalizeCode39Value(el.value);
  const barHeight = Math.max(20, Math.round(el.height || 80));
  const narrow = 2;
  const wide = 5;
  const quiet = 10;
  const encoded = `*${value}*`;
  const patternWidth = [...encoded].reduce((total, char) => {
    return (
      total +
      CODE39_PATTERNS[char]
        .split("")
        .reduce((sum, mark) => sum + (mark === "w" ? wide : narrow), 0) +
      narrow
    );
  }, 0);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = patternWidth + quiet * 2;
  canvas.height = barHeight + 24;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawCode39ToCanvas(ctx, value, quiet, 0, {
    narrow,
    wide,
    barHeight,
    textHeight: 24,
    drawText: true,
  });

  return canvasToEplGraphic(canvas, el.x, el.y, orientation, {
    invert: true,
    lengthOffset,
  });
}

function code39ToEplLines(
  el,
  printStartOffset = 0,
  printDirection = "bookingqube",
) {
  const value = normalizeCode39Value(el.value);
  const encoded = `*${value}*`;
  const narrow = 2;
  const wide = 5;
  const quiet = 10;
  const barHeight = Math.max(20, Math.round(el.height || 80));
  const shouldFlip = printDirection === "bookingqube";
  const lines = [];
  let cx = quiet;

  for (const char of encoded) {
    const pattern = CODE39_PATTERNS[char];
    for (let i = 0; i < pattern.length; i++) {
      const segmentWidth = pattern[i] === "w" ? wide : narrow;
      if (i % 2 === 0) {
        const printerX = Math.round(el.y);
        const segmentX = Math.round(el.x) + cx;
        const printerY = mapPreviewLengthToPrinterY(
          segmentX,
          shouldFlip ? segmentWidth : 0,
          printStartOffset,
          printDirection,
        );
        lines.push(`LO${printerX},${printerY},${barHeight},${segmentWidth}`);
      }
      cx += segmentWidth;
    }
    cx += narrow;
  }

  const textX = Math.round(el.y + barHeight + 4);
  const textY = mapPreviewLengthToPrinterY(
    Math.round(el.x + quiet + 8),
    0,
    printStartOffset,
    printDirection,
  );
  lines.push(`A${textX},${textY},${shouldFlip ? 3 : 1},2,1,1,N,"${value}"`);

  return lines;
}

function qrToEplLines(value, x, y, moduleSize = 4) {
  const qr = qrcode(0, "M");
  qr.addData(String(value || ""));
  qr.make();

  const lines = [];
  const count = qr.getModuleCount();
  const quiet = moduleSize * 4;
  const originX = Math.round(x) + quiet;
  const originY = Math.round(y) + quiet;

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        lines.push(
          `LO${originX + col * moduleSize},${originY + row * moduleSize},${moduleSize},${moduleSize}`,
        );
      }
    }
  }

  return lines;
}

function qrToPreviewMappedEplLines(
  value,
  previewX,
  previewY,
  printStartOffset = 0,
  moduleSize = 4,
  printDirection = "opposite",
) {
  const qr = qrcode(0, "M");
  qr.addData(String(value || ""));
  qr.make();

  const lines = [];
  const count = qr.getModuleCount();
  const quiet = moduleSize * 4;
  const startX = Math.round(previewX) + quiet;
  const startY = Math.round(previewY) + quiet;

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        const printerX = startY + row * moduleSize;
        const previewModuleX = startX + col * moduleSize;
        const printerY = mapPreviewLengthToPrinterY(
          previewModuleX,
          printDirection === "bookingqube" ? moduleSize : 0,
          printStartOffset,
          printDirection,
        );
        lines.push(`LO${printerX},${printerY},${moduleSize},${moduleSize}`);
      }
    }
  }

  return lines;
}

function mediaCommand(
  labelLength,
  mediaMode = "continuous",
  markThickness,
  markOffset,
) {
  const length = Math.max(200, Number(labelLength || DEFAULT_LABEL_LENGTH_DOTS));
  if (mediaMode === "continuous") return `Q${length},0`;

  const thickness = Math.max(
    16,
    Math.min(240, Math.round(markThickness || DEFAULT_MARK_THICKNESS_DOTS)),
  );
  const offset = Math.max(0, Math.round(markOffset || 0));
  return `Q${length},B${thickness}+${offset}`;
}

function buildBasicEPL2({
  elements,
  logoImg = null,
  darkness = 14,
  speed = 2,
  labelLength = DEFAULT_LABEL_LENGTH_DOTS,
  mediaMode = "continuous",
  markThickness = DEFAULT_MARK_THICKNESS_DOTS,
  markOffset = DEFAULT_MARK_OFFSET_DOTS,
  printStartOffset = 0,
  copies = 1,
  codeType = "barcode",
  printDirection = "bookingqube",
  barcodeRotation = 1,
  barcodeMode = "lines",
  barcodePrintX = 70,
  barcodePrintY = 120,
  barcodePrintHeight = 95,
}) {
  const lines = [];
  const textEls = elements.filter((el) => el.type === "text");
  const barcodeEl = elements.find((el) => el.type === "barcode");
  const logoEls = elements.filter((el) => el.type === "logo");

  lines.push("N");
  lines.push("JB");
  lines.push(`D${darkness}`);
  lines.push(`S${speed}`);
  lines.push(`q${BAND_WIDTH_DOTS}`);
  lines.push(mediaCommand(labelLength, mediaMode, markThickness, markOffset));

  if (logoImg) {
    logoEls.forEach((el) => {
      const flipX = printDirection === "bookingqube";
      const adjustedEl = flipX
        ? { ...el, x: PRINTABLE_LENGTH_DOTS - el.x - (el.w || 80) }
        : el;
      lines.push(
        imageToEplGraphic(logoImg, adjustedEl, "horizontal", printStartOffset, {
          flipX,
          invert: true,
        }),
      );
    });
  }

  textEls.forEach((el) => {
    const font = el.font || 3;
    const hm = el.hm || 1;
    const vm = el.vm || 1;
    const flipToArtwork = printDirection === "bookingqube";
    const x = Math.max(
      0,
      Math.round(el.y + (flipToArtwork ? estimateEplTextHeight(font, vm) : 0)),
    );
    const y = mapPreviewLengthToPrinterY(
      el.x,
      0,
      printStartOffset,
      printDirection,
    );
    lines.push(
      `A${x},${y},${flipToArtwork ? 3 : 1},${font},${hm},${vm},N,"${el.value || ""}"`,
    );
  });

  if (barcodeEl) {
    if (codeType === "qr") {
      lines.push(
        ...qrToPreviewMappedEplLines(
          barcodeEl.value,
          barcodeEl.x,
          barcodeEl.y,
          printStartOffset,
          4,
          printDirection,
        ),
      );
    } else if (barcodeMode === "lines" && barcodeRotation === 1) {
      lines.push(
        ...code39ToEplLines(barcodeEl, printStartOffset, printDirection),
      );
    } else {
      const flipToArtwork = printDirection === "bookingqube";
      const x = Math.max(0, Math.round(barcodeEl.y));
      const y = mapPreviewLengthToPrinterY(
        barcodeEl.x,
        0,
        printStartOffset,
        printDirection,
      );
      lines.push(
        `B${x},${y},${flipToArtwork ? 3 : barcodeRotation},3,2,5,${barcodeEl.height || barcodePrintHeight},B,"${normalizeCode39Value(barcodeEl.value)}"`,
      );
    }
  }

  lines.push(`P${Math.max(1, Math.round(copies || 1))}`);
  return `${lines.join("\r\n")}\r\n`;
}

function mapElementToPrinter(el, orientation) {
  if (orientation !== "horizontal")
    return {
      x: Math.round(el.x),
      y: Math.round(el.y),
      rotation: el.rotation || 0,
    };
  return { x: Math.round(el.y), y: Math.round(el.x), rotation: 1 };
}

function buildEPL2({
  elements,
  logoImg,
  darkness = 14,
  speed = 2,
  labelLength = DEFAULT_LABEL_LENGTH_DOTS,
  printStartOffset = 0,
  copies = 1,
  orientation = "horizontal",
  includeGraphics = true,
}) {
  const lines = [];
  lines.push("N");
  lines.push("JB");
  lines.push(`D${darkness}`);
  lines.push(`S${speed}`);
  lines.push(`q${BAND_WIDTH_DOTS}`);
  lines.push(mediaCommand(labelLength));

  elements.forEach((el) => {
    const mapped = mapElementToPrinter(el, orientation);
    const y = Math.max(0, mapped.y + Math.round(printStartOffset || 0));
    if (el.type === "text") {
      lines.push(
        `A${mapped.x},${y},${mapped.rotation},${el.font || 3},${el.hm || 1},${el.vm || 1},N,"${el.value}"`,
      );
    } else if (el.type === "barcode") {
      if (orientation === "horizontal") {
        lines.push(...code39ToEplLines(el, printStartOffset));
      } else {
        lines.push(
          `B${mapped.x},${y},${mapped.rotation},3,2,5,${el.height || 80},B,"${normalizeCode39Value(el.value)}"`,
        );
      }
    } else if (el.type === "qr") {
      lines.push(`b${mapped.x},${y},Q,"${el.value}"`);
    } else if (el.type === "logo" && logoImg) {
      lines.push(`A${mapped.x},${y},${mapped.rotation},2,1,1,N,"LOGO"`);
    }
  });

  lines.push(`P${Math.max(1, Math.round(copies || 1))}`);
  return `${lines.join("\r\n")}\r\n`;
}

// ── Canvas preview renderer ───────────────────────────────────────────────────
function drawQrToCanvas(ctx, value, x, y, moduleSize = 4) {
  const qr = qrcode(0, "M");
  qr.addData(String(value || ""));
  qr.make();

  const count = qr.getModuleCount();
  const quiet = moduleSize * 4;
  ctx.fillStyle = "#111";

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(
          x + quiet + col * moduleSize,
          y + quiet + row * moduleSize,
          moduleSize,
          moduleSize,
        );
      }
    }
  }
}

function drawPreview(canvas, elements, logoImg, codeType = "barcode") {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Wristband background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, W, H);

  elements.forEach((el) => {
    ctx.save();
    if (el.type === "text") {
      const fs = (el.font || 3) * 6 + (el.vm || 1) * 4;
      ctx.font = `bold ${fs}px 'Courier New', monospace`;
      ctx.fillStyle = "#111";
      ctx.fillText(el.value || "", el.x, el.y + fs);
    } else if (el.type === "barcode") {
      if (codeType === "qr") {
        drawQrToCanvas(ctx, el.value || "0000000", el.x, el.y, 4);
      } else {
        drawCode39ToCanvas(ctx, el.value || "0000000", el.x, el.y, {
          barHeight: el.height || 80,
        });
      }
    } else if (el.type === "logo" && logoImg) {
      const w = el.w || 80,
        h = el.h || 40;
      ctx.drawImage(logoImg, el.x, el.y, w, h);
    }
    ctx.restore();
  });
}

// ── Default element set ───────────────────────────────────────────────────────
// Horizontal designer area: 1358 long × 203 wide (17 cm × 1")
const DEFAULT_ELEMENTS = [
  { id: "logo", type: "logo", label: "Logo", x: 40, y: 24, w: 170, h: 70 },
  {
    id: "name",
    type: "text",
    label: "Name",
    value: "John Doe",
    x: 260,
    y: 42,
    font: 3,
    hm: 1,
    vm: 1,
  },
  {
    id: "id",
    type: "text",
    label: "ID",
    value: "ID: 00123",
    x: 260,
    y: 92,
    font: 2,
    hm: 1,
    vm: 1,
  },
  {
    id: "barcode",
    type: "barcode",
    label: "Barcode",
    value: "1234567890",
    x: 520,
    y: 38,
    height: 50,
  },
];

// ── Theme ─────────────────────────────────────────────────────────────────────
const DARK = {
  bg: "#0a0f1a",
  bgAlt: "#0d1525",
  surface: "#0f1829",
  surfaceAlt: "#182035",
  border: "#1e293b",
  borderStrong: "#334155",
  text: "#f1f5f9",
  textSub: "#94a3b8",
  textMuted: "#475569",
  accent: "#60a5fa",
  accentBg: "#1e3a5f",
  accentBorder: "#2563eb",
  dangerBg: "#3f1d1d",
  dangerBorder: "#7f1d1d",
  dangerText: "#fca5a5",
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
  inputBg: "#1e293b",
  inputBorder: "#334155",
  btnSecondary: "#1e293b",
  btnSecondaryBorder: "#334155",
  btnSecondaryText: "#cbd5e1",
  codeBg: "#050a14",
  codeText: "#22d3ee",
  shadow: "0 1px 3px rgba(0,0,0,0.5)",
  shadowLg: "0 8px 24px rgba(0,0,0,0.6)",
};
const LIGHT = {
  bg: "#f8fafc",
  bgAlt: "#f1f5f9",
  surface: "#ffffff",
  surfaceAlt: "#f8fafc",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  text: "#0f172a",
  textSub: "#475569",
  textMuted: "#94a3b8",
  accent: "#2563eb",
  accentBg: "#eff6ff",
  accentBorder: "#bfdbfe",
  dangerBg: "#fff1f2",
  dangerBorder: "#fecdd3",
  dangerText: "#e11d48",
  success: "#16a34a",
  warning: "#d97706",
  error: "#ef4444",
  inputBg: "#ffffff",
  inputBorder: "#cbd5e1",
  btnSecondary: "#ffffff",
  btnSecondaryBorder: "#d1d5db",
  btnSecondaryText: "#374151",
  codeBg: "#f1f5f9",
  codeText: "#0369a1",
  shadow: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
  shadowLg: "0 8px 20px rgba(0,0,0,0.1)",
};

function hBtn(t, variant = "neutral") {
  const base = {
    padding: "7px 14px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
    fontWeight: 600,
    border: "1px solid",
  };
  if (variant === "accent")
    return {
      ...base,
      background: t.accentBg,
      borderColor: t.accentBorder,
      color: t.accent,
    };
  if (variant === "danger")
    return {
      ...base,
      background: t.dangerBg,
      borderColor: t.dangerBorder,
      color: t.dangerText,
    };
  return {
    ...base,
    background: t.btnSecondary,
    borderColor: t.btnSecondaryBorder,
    color: t.btnSecondaryText,
  };
}

// ── Main component ────────────────────────────────────────────────────────────
function ZebraAppContent() {
  const canvasRef = useRef(null);
  const [elements, setElements] = useState(DEFAULT_ELEMENTS);
  const [logoFile, setLogoFile] = useState(null);
  const [logoImg, setLogoImg] = useState(null);
  const [printer, setPrinter] = useState(null);
  const [printers, setPrinters] = useState([]);
  const [printerStatus, setPrinterStatus] = useState("disconnected"); // disconnected | connecting | connected | error
  const [printerMsg, setPrinterMsg] = useState("");
  const [printStatus, setPrintStatus] = useState("");
  const [clearing, setClearing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [copies, setCopies] = useState(1);
  const [darkness, setDarkness] = useState(14);
  const [labelLength, setLabelLength] = useState(DEFAULT_LABEL_LENGTH_DOTS);
  const [mediaMode, setMediaMode] = useState("continuous");
  const [markThickness, setMarkThickness] = useState(DEFAULT_MARK_THICKNESS_DOTS);
  const [markOffset, setMarkOffset] = useState(DEFAULT_MARK_OFFSET_DOTS);
  const [printStartOffset, setPrintStartOffset] = useState(0);
  const [codeType, setCodeType] = useState("barcode");
  const [printDirection, setPrintDirection] = useState("bookingqube");
  const [barcodeRotation, setBarcodeRotation] = useState(1);
  const [barcodeMode, setBarcodeMode] = useState("lines");
  const [barcodePrintX, setBarcodePrintX] = useState(70);
  const [barcodePrintY, setBarcodePrintY] = useState(120);
  const [barcodePrintHeight, setBarcodePrintHeight] = useState(95);
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [darkMode, setDarkMode] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const t = darkMode ? DARK : LIGHT;

  const selectedPrinter = () =>
    printers.find((name) => /zebra.*raw|raw.*zebra/i.test(name)) || printer;

  // Redraw canvas whenever elements or logo change
  useEffect(() => {
    drawPreview(canvasRef.current, elements, logoImg, codeType);
  }, [elements, logoImg, codeType]);

  // Connect via local print server
  const connectPrinter = useCallback(async () => {
    setPrinterStatus("connecting");
    setPrinterMsg("Searching for printer…");
    try {
      const data = await PrintAPI.findPrinter();
      setPrinters(data.printers || []);
      if (data.suggested) {
        const preferred =
          (data.printers || []).find((name) => /raw/i.test(name)) ||
          data.suggested;
        setPrinter(preferred);
        setPrinterStatus("connected");
        setPrinterMsg(`Connected: ${preferred}`);
      } else {
        setPrinterStatus("error");
        setPrinterMsg(data.message || "No printer found. Is it plugged in?");
      }
    } catch {
      setPrinterStatus("error");
      setPrinterMsg("Print server not running. Run: npm start");
    }
  }, []);

  useEffect(() => {
    connectPrinter();
  }, [connectPrinter]);

  const clearPrinterJobs = useCallback(async () => {
    const targetPrinter = selectedPrinter();
    if (!targetPrinter) {
      setPrintStatus("Connect a printer before clearing jobs.");
      return;
    }

    setClearing(true);
    setPrintStatus("Clearing pending printer jobs...");
    try {
      const data = await PrintAPI.clearPrinter(targetPrinter);
      if (data.ok) {
        setPrintStatus("Pending jobs cleared and printer queue re-enabled.");
      } else {
        setPrintStatus(`Could not clear jobs: ${data.error}`);
      }
    } catch {
      setPrintStatus("Could not reach print server while clearing jobs.");
    } finally {
      setClearing(false);
    }
  }, [printer, printers]);

  // Handle logo upload
  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => setLogoImg(img);
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  // Update element field
  const updateEl = (id, field, value) => {
    setElements((els) =>
      els.map((el) => (el.id === id ? { ...el, [field]: value } : el)),
    );
  };

  const clampDesignPoint = (x, y) => ({
    x: Math.max(0, Math.min(PRINTABLE_LENGTH_DOTS, Math.round(x))),
    y: Math.max(0, Math.min(BAND_WIDTH_DOTS, Math.round(y))),
  });

  // Canvas drag handling
  const getElAtPos = (x, y) => {
    return [...elements].reverse().find((el) => {
      const w =
        el.type === "text" ? 180 : el.type === "barcode" ? 160 : el.w || 80;
      const h =
        el.type === "text"
          ? 30
          : el.type === "barcode"
            ? (el.height || 80) + 20
            : el.h || 40;
      return x >= el.x && x <= el.x + w && y >= el.y && y <= el.y + h;
    });
  };

  const onCanvasMouseDown = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const el = getElAtPos(x, y);
    if (el) {
      setSelected(el.id);
      setDragging(el.id);
      setDragOffset({ x: x - el.x, y: y - el.y });
    }
  };

  const onCanvasMouseMove = (e) => {
    if (!dragging) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const next = clampDesignPoint(
      (e.clientX - rect.left) * scaleX - dragOffset.x,
      (e.clientY - rect.top) * scaleY - dragOffset.y,
    );
    updateEl(dragging, "x", next.x);
    updateEl(dragging, "y", next.y);
  };

  const onCanvasMouseUp = () => setDragging(null);

  // Print
  const handlePrint = async () => {
    if (printing) return;

    console.log("[PrintButton] clicked", {
      printer,
      printers,
      copies,
      darkness,
      labelLength,
      mediaMode,
      markThickness,
      markOffset,
      printStartOffset,
      codeType,
      printDirection,
      barcodeRotation,
      barcodeMode,
      barcodePrintX,
      barcodePrintY,
      barcodePrintHeight,
      elements,
    });

    const epl = buildBasicEPL2({
      elements,
      logoImg,
      darkness,
      labelLength,
      mediaMode,
      markThickness,
      markOffset,
      printStartOffset,
      copies,
      codeType,
      printDirection,
      barcodeRotation,
      barcodeMode,
      barcodePrintX,
      barcodePrintY,
      barcodePrintHeight,
    });
    const previewEpl = buildBasicEPL2({
      elements,
      darkness,
      labelLength,
      mediaMode,
      markThickness,
      markOffset,
      printStartOffset,
      copies,
      codeType,
      printDirection,
      barcodeRotation,
      barcodeMode,
      barcodePrintX,
      barcodePrintY,
      barcodePrintHeight,
    });

    const targetPrinter = selectedPrinter();
    console.log("[PrintButton] generated EPL", {
      targetPrinter,
      bytes: epl.length,
      epl: previewEpl,
    });
    if (!targetPrinter) {
      alert(
        "No printer connected.\n\nEPL2 that would be sent:\n\n" + previewEpl,
      );
      return;
    }

    setPrinting(true);
    setPrintStatus("Sending to printer...");
    try {
      const data = await PrintAPI.print(targetPrinter, epl);
      console.log("[PrintButton] print result", data);
      if (data.ok) {
        setPrintStatus(`Sent ${copies} wristband job(s) to ${targetPrinter}.`);
      } else {
        setPrintStatus(`Print error: ${data.error}`);
      }
    } catch {
      setPrintStatus("Could not reach print server. Is it running?");
    } finally {
      setPrinting(false);
    }
  };

  const handleTestPrint = async () => {
    const targetPrinter = selectedPrinter();
    if (!targetPrinter) {
      setPrintStatus("Connect a printer before test printing.");
      return;
    }

    setPrinting(true);
    setPrintStatus("Sending test print...");
    try {
      const data = await PrintAPI.print(targetPrinter, WORKING_TEST_EPL);
      if (data.ok) {
        setPrintStatus(`Test print sent to ${targetPrinter}.`);
      } else {
        setPrintStatus(`Test print error: ${data.error}`);
      }
    } catch {
      setPrintStatus("Could not reach print server for test print.");
    } finally {
      setPrinting(false);
    }
  };

  const statusColor = { disconnected: t.textMuted, connecting: t.warning, connected: t.success, error: t.error }[printerStatus];
  const inp = { background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 8, padding: "8px 11px", color: t.text, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box", outline: "none", width: "100%" };


  return (
    <div style={{ fontFamily: "'Inter','Segoe UI',system-ui,-apple-system,sans-serif", background: t.bg, minHeight: "100vh", color: t.text, display: "flex", flexDirection: "column", fontSize: 14 }}>

      {/* Header */}
      <header style={{ height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", background: t.surface, borderBottom: `1px solid ${t.border}`, boxShadow: t.shadow, flexShrink: 0, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, background: "linear-gradient(135deg,#2563eb,#06b6d4)", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>🖨</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em" }}>Wristband Studio</div>
            <div style={{ fontSize: 11, color: t.textMuted }}>Zebra LP2824 · EPL2</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: t.bgAlt, border: `1px solid ${t.border}`, borderRadius: 20, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, display: "inline-block", boxShadow: `0 0 0 3px ${statusColor}25` }} />
            <span style={{ color: t.textSub, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{printerMsg || "Not connected"}</span>
          </div>
          <Btn t={t} variant="accent" onClick={connectPrinter}>{printerStatus === "connected" ? "Reconnect" : "Connect"}</Btn>
          <Btn t={t} variant="danger" onClick={clearPrinterJobs} disabled={!printer || clearing}>{clearing ? "Clearing…" : "Clear Jobs"}</Btn>
          <Btn t={t} onClick={() => setDarkMode(d => !d)} style={{ width: 34, padding: 0, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>{darkMode ? "☀️" : "🌙"}</Btn>
        </div>
      </header>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Preview panel */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 28px", background: t.bgAlt, gap: 14, overflow: "hidden" }}>
          <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Live Preview</span>
              <span style={{ fontSize: 11, color: t.textMuted, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 5, padding: "2px 8px" }}>drag elements to reposition</span>
            </div>
            <div style={{ background: t.surface, borderRadius: 16, border: `1px solid ${t.border}`, padding: "20px 20px 16px", boxShadow: t.shadowLg, display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
              <div style={{ width: "100%", borderRadius: 8, overflow: "hidden", border: `1.5px solid ${t.border}` }}>
                <canvas ref={canvasRef} width={PRINTABLE_LENGTH_DOTS} height={BAND_WIDTH_DOTS}
                  style={{ display: "block", width: "100%", height: "auto", cursor: "crosshair" }}
                  onMouseDown={onCanvasMouseDown} onMouseMove={onCanvasMouseMove}
                  onMouseUp={onCanvasMouseUp} onMouseLeave={onCanvasMouseUp} />
              </div>
              <div style={{ display: "flex", gap: 20, fontSize: 11, color: t.textMuted }}>
                <span>1358 × 203 dots</span><span>·</span><span>17 cm × 1"</span><span>·</span><span>203 dpi</span>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ width: 370, flexShrink: 0, overflowY: "auto", background: t.bg, borderLeft: `1px solid ${t.border}` }}>
          <div style={{ padding: "18px 18px 32px", display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Printer */}
            <Card t={t} title="Printer">
              <select style={inp} value={printer || ""} onChange={e => { setPrinter(e.target.value || null); if (e.target.value) { setPrinterStatus("connected"); setPrinterMsg(`Connected: ${e.target.value}`); } }}>
                <option value="">Select printer…</option>
                {printers.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <Btn t={t} variant="accent" onClick={connectPrinter} style={{ width: "100%" }}>Refresh Printers</Btn>
            </Card>

            {/* Wristband Content */}
            <Card t={t} title="Wristband Content">
              {elements.filter(e => e.type === "text").map(el => (
                <Field key={el.id} label={el.label} t={t}>
                  <input style={inp} value={el.value} onChange={e => updateEl(el.id, "value", e.target.value)} placeholder={`Enter ${el.label.toLowerCase()}…`} />
                </Field>
              ))}
              {elements.filter(e => e.type === "barcode").map(el => (
                <Field key={el.id} label="Barcode" t={t}>
                  <input style={{ ...inp, fontFamily: "monospace" }} value={el.value} onChange={e => updateEl(el.id, "value", e.target.value)} placeholder="Barcode value…" />
                </Field>
              ))}
            </Card>

            {/* Logo */}
            <Card t={t} title="Logo">
              <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px", background: logoImg ? t.accentBg : t.bgAlt, border: `1.5px dashed ${logoImg ? t.accentBorder : t.borderStrong}`, borderRadius: 10, cursor: "pointer", fontSize: 13, color: logoImg ? t.accent : t.textSub, fontWeight: logoImg ? 600 : 400 }}>
                <input type="file" accept="image/*" onChange={handleLogoUpload} style={{ display: "none" }} />
                {logoFile ? `✅ ${logoFile.name}` : "📁 Click to upload logo"}
              </label>
              {logoImg && (
                <Field label="Size" t={t}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="range" min={20} max={200} value={elements.find(e => e.id === "logo")?.w || 80}
                      onChange={e => { const v = +e.target.value; updateEl("logo", "w", v); updateEl("logo", "h", Math.round(v * 0.5)); }}
                      style={{ flex: 1, accentColor: t.accent }} />
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: t.textSub, minWidth: 36 }}>{elements.find(e => e.id === "logo")?.w || 80}px</span>
                  </div>
                </Field>
              )}
            </Card>

            {/* Print */}
            <Card t={t} title="Print">
              <div style={{ display: "flex", gap: 10 }}>
                <Field label="Copies" t={t} style={{ flex: 1 }}>
                  <input type="number" min={1} max={100} value={copies} onChange={e => setCopies(Math.max(1, +e.target.value))} style={inp} />
                </Field>
                <Field label={`Darkness · ${darkness}`} t={t} style={{ flex: 1 }}>
                  <input type="range" min={1} max={15} value={darkness} onChange={e => setDarkness(+e.target.value)} style={{ width: "100%", accentColor: t.accent, marginTop: 4 }} />
                </Field>
              </div>
              <button onClick={handlePrint} disabled={printing}
                style={{ padding: "14px", background: printing ? t.borderStrong : "linear-gradient(135deg,#2563eb,#0ea5e9)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: printing ? "not-allowed" : "pointer", width: "100%", boxShadow: printing ? "none" : "0 4px 18px rgba(37,99,235,0.38)", letterSpacing: "0.01em" }}>
                {printing ? "Sending to printer…" : `Print ${copies} Wristband${copies > 1 ? "s" : ""}`}
              </button>
              <button onClick={handleTestPrint} disabled={printing}
                style={{ padding: "10px", background: "transparent", border: `1.5px solid ${t.borderStrong}`, borderRadius: 10, color: t.textSub, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: printing ? "not-allowed" : "pointer", width: "100%", opacity: printing ? 0.5 : 1 }}>
                Send Test Print
              </button>
              {printStatus && <div style={{ fontSize: 12, padding: "10px 12px", background: t.bgAlt, border: `1px solid ${t.border}`, borderRadius: 8, color: t.textSub, textAlign: "center", lineHeight: 1.6 }}>{printStatus}</div>}
              <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
                Manual length mode sends the feed pitch exactly as entered.
              </div>
            </Card>

            {/* Advanced toggle */}
            <button onClick={() => setShowAdvanced(s => !s)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "11px 16px", background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, color: t.textSub, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: t.shadow }}>
              <span>Advanced Settings</span>
              <span style={{ fontSize: 10, transform: showAdvanced ? "rotate(180deg)" : "none", display: "inline-block", transition: "transform 0.2s" }}>▼</span>
            </button>

            {showAdvanced && <>
              <Card t={t} title="Element Positions">
                {elements.filter(e => e.type === "text").map(el => (
                  <div key={el.id} onClick={() => setSelected(el.id)} style={{ padding: "10px", borderRadius: 8, border: `1px solid ${selected === el.id ? t.accentBorder : t.border}`, background: selected === el.id ? t.accentBg : t.bgAlt, cursor: "pointer" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>{el.label}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <CI label="X" value={el.x} onChange={v => updateEl(el.id, "x", v)} t={t} />
                      <CI label="Y" value={el.y} onChange={v => updateEl(el.id, "y", v)} t={t} />
                      <CI label="Fn" value={el.font} onChange={v => updateEl(el.id, "font", v)} t={t} min={1} max={5} />
                    </div>
                  </div>
                ))}
                {elements.filter(e => e.type === "barcode").map(el => (
                  <div key={el.id} onClick={() => setSelected(el.id)} style={{ padding: "10px", borderRadius: 8, border: `1px solid ${selected === el.id ? t.accentBorder : t.border}`, background: selected === el.id ? t.accentBg : t.bgAlt, cursor: "pointer" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Barcode</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CI label="X" value={el.x} onChange={v => updateEl(el.id, "x", v)} t={t} />
                      <CI label="Y" value={el.y} onChange={v => updateEl(el.id, "y", v)} t={t} />
                      <CI label="H" value={el.height || 50} onChange={v => updateEl(el.id, "height", v)} t={t} />
                    </div>
                  </div>
                ))}
                {elements.filter(e => e.type === "logo").map(el => (
                  <div key={el.id} style={{ padding: "10px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgAlt }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Logo</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CI label="X" value={el.x} onChange={v => updateEl(el.id, "x", v)} t={t} />
                      <CI label="Y" value={el.y} onChange={v => updateEl(el.id, "y", v)} t={t} />
                    </div>
                  </div>
                ))}
              </Card>

              <Card t={t} title="Print Settings">
                {[
                  { label: "Media", node: <select style={inp} value={mediaMode} onChange={e => setMediaMode(e.target.value)}><option value="continuous">Manual length</option><option value="blackMark">Black mark</option></select> },
                  { label: "Feed Pitch", node: <><input type="number" min={200} max={3000} step="any" value={labelLength} onChange={e => setLabelLength(e.target.value)} style={{ ...inp, width: 90, fontFamily: "monospace" }} /><span style={{ fontSize: 11, color: t.textMuted }}>dots · default 1280.2</span></> },
                  { label: "Mark", node: <><input type="number" min={16} max={240} value={markThickness} onChange={e => setMarkThickness(Math.max(16, Math.min(240, +e.target.value)))} disabled={mediaMode !== "blackMark"} style={{ ...inp, width: 90, fontFamily: "monospace", opacity: mediaMode === "blackMark" ? 1 : 0.55 }} /><span style={{ fontSize: 11, color: t.textMuted }}>dots thick</span></> },
                  { label: "Tear", node: <><input type="number" min={0} max={500} value={markOffset} onChange={e => setMarkOffset(Math.max(0, +e.target.value))} disabled={mediaMode !== "blackMark"} style={{ ...inp, width: 90, fontFamily: "monospace", opacity: mediaMode === "blackMark" ? 1 : 0.55 }} /><span style={{ fontSize: 11, color: t.textMuted }}>dots after mark</span></> },
                  { label: "Offset", node: <><input type="number" min={-500} max={500} value={printStartOffset} onChange={e => setPrintStartOffset(+e.target.value)} style={{ ...inp, width: 90, fontFamily: "monospace" }} /><span style={{ fontSize: 11, color: t.textMuted }}>dots</span></> },
                  { label: "Code", node: <select style={inp} value={codeType} onChange={e => setCodeType(e.target.value)}><option value="barcode">Code 39</option><option value="qr">QR Code</option></select> },
                  { label: "Direction", node: <select style={inp} value={printDirection} onChange={e => setPrintDirection(e.target.value)}><option value="bookingqube">Bookingqube</option><option value="opposite">Opposite</option></select> },
                  { label: "Rotation", node: <select style={inp} value={barcodeRotation} onChange={e => setBarcodeRotation(+e.target.value)}><option value={0}>0°</option><option value={1}>90°</option><option value={2}>180°</option><option value={3}>270°</option></select> },
                  { label: "B Mode", node: <select style={inp} value={barcodeMode} onChange={e => setBarcodeMode(e.target.value)}><option value="lines">Lines</option><option value="native">Native</option></select> },
                ].map(({ label, node }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, color: t.textSub, width: 76, flexShrink: 0 }}>{label}</span>
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>{node}</div>
                  </div>
                ))}
              </Card>
            </>}

            {/* Setup guide */}
            <div style={{ padding: "14px 16px", background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, boxShadow: t.shadow }}>
              <div style={{ fontWeight: 700, color: t.accent, marginBottom: 8, fontSize: 12 }}>First-time setup</div>
              <ol style={{ margin: 0, paddingLeft: 18, color: t.textSub, lineHeight: 2, fontSize: 12 }}>
                <li>Connect LP2824 via USB</li>
                <li>System Settings → Printers &amp; Scanners → add</li>
                <li>Run <code style={{ background: t.codeBg, color: t.codeText, borderRadius: 3, padding: "1px 5px", fontFamily: "monospace" }}>npm start</code> in the project folder</li>
                <li>Click <b>Connect</b> above</li>
              </ol>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default function ZebraApp() {
  return (
    <AppErrorBoundary>
      <ZebraAppContent />
    </AppErrorBoundary>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function Btn({ t, variant = "neutral", onClick, disabled, style = {}, children }) {
  const base = { padding: "7px 14px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600, border: "1px solid", opacity: disabled ? 0.5 : 1 };
  const v = variant === "accent" ? { background: t.accentBg, borderColor: t.accentBorder, color: t.accent }
           : variant === "danger" ? { background: t.dangerBg, borderColor: t.dangerBorder, color: t.dangerText }
           : { background: t.btnSecondary, borderColor: t.btnSecondaryBorder, color: t.btnSecondaryText };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...v, ...style }}>{children}</button>;
}

function Card({ t, title, children }) {
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, overflow: "hidden", boxShadow: t.shadow }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${t.border}`, background: t.bgAlt }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{title}</span>
      </div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function Field({ label, children, t, style = {} }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, ...style }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: t.textSub }}>{label}</label>
      {children}
    </div>
  );
}

function CI({ label, value, onChange, t, min, max }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, width: 18 }}>{label}</span>
      <input type="number" value={value} min={min} max={max} onChange={e => onChange(+e.target.value)}
        style={{ width: 62, background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6, padding: "5px 7px", color: t.text, fontFamily: "monospace", fontSize: 12 }} />
    </label>
  );
}
