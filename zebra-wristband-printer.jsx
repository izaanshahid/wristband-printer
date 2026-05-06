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
    const data = await res.json().catch(() => ({ error: `Print server returned HTTP ${res.status}` }));
    console.log("[PrintAPI] /api/print response", { status: res.status, data });
    if (!res.ok) return { error: data.error || `Print server returned HTTP ${res.status}` };
    return data; // { ok } or { error }
  },
  clearPrinter: async (printerName) => {
    const res = await fetch(`${SERVER}/api/clear-printer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printer: printerName }),
    });
    const data = await res.json().catch(() => ({ error: `Print server returned HTTP ${res.status}` }));
    if (!res.ok) return { error: data.error || `Print server returned HTTP ${res.status}` };
    return data;
  },
};

const BAND_WIDTH_DOTS = 203;
const PRINTABLE_LENGTH_DOTS = 1358;
const DEFAULT_LABEL_LENGTH_DOTS = 1143;
const WORKING_TEST_EPL = 'N\r\nD10\r\nS2\r\nq203\r\nQ2238,0\r\nA20,40,0,3,1,1,N,"SERVER TEST"\r\nP1\r\n';
const CODE39_PATTERNS = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn",
  "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
  "8": "wnnwnnwnn", "9": "nnwwnnwnn", A: "wnnnnwnnw", B: "nnwnnwnnw",
  C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn", F: "nnwnwwnnn",
  G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn",
  K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww",
  O: "wnnnwnnwn", P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn",
  S: "nnwnnnwwn", T: "nnnnwnwwn", U: "wwnnnnnnw", V: "nwwnnnnnw",
  W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn", Z: "nwwnwnnnn",
  "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "$": "nwnwnwnnn",
  "/": "nwnwnnnwn", "+": "nwnnnwnwn", "%": "nnnwnwnwn", "*": "nwnnwnwnn",
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
        <div style={{ padding: 24, color: "#fecaca", fontFamily: "monospace", background: "#0a0f1a", minHeight: "100vh" }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>App crashed</h1>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.stack || this.state.error.message}</pre>
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
function canvasToEplGraphic(sourceCanvas, x, y, orientation = "horizontal", options = {}) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const sourceCtx = sourceCanvas.getContext("2d");
  const sourcePixels = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;
  const outputWidth = orientation === "horizontal" ? sourceHeight : sourceWidth;
  const outputHeight = orientation === "horizontal" ? sourceWidth : sourceHeight;
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
        const luma = sourcePixels[i] * 0.299 + sourcePixels[i + 1] * 0.587 + sourcePixels[i + 2] * 0.114;
        const darkPixel = alpha > 127 && luma < 160;
        const setBit = options.invert ? !darkPixel : darkPixel;
        if (setBit) byte |= 1 << (7 - bit);
      }
      data += String.fromCharCode(byte);
    }
  }

  const eplX = orientation === "horizontal" ? Math.round(y) : Math.round(x);
  const eplY = orientation === "horizontal" ? Math.round(x + (options.lengthOffset || 0)) : Math.round(y);
  return `GW${eplX},${eplY},${bytesPerRow},${outputHeight},${data}`;
}

function imageToEplGraphic(img, el, orientation = "horizontal", lengthOffset = 0, options = {}) {
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

  return canvasToEplGraphic(canvas, el.x, el.y, orientation, { lengthOffset, invert: options.invert });
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
    return total + pattern.split("").reduce((sum, mark) => sum + (mark === "w" ? wide : narrow), 0) + narrow;
  }, 0);
}

function estimateEplTextAdvance(value, font = 3, hm = 1) {
  const charWidthByFont = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 32 };
  return String(value || "").length * (charWidthByFont[font] || 12) * Math.max(1, hm || 1);
}

function estimateEplTextHeight(font = 3, vm = 1) {
  const charHeightByFont = { 1: 12, 2: 16, 3: 20, 4: 24, 5: 48 };
  return (charHeightByFont[font] || 20) * Math.max(1, vm || 1);
}

function mapPreviewLengthToPrinterY(previewX, elementLength = 0, printStartOffset = 0, printDirection = "opposite") {
  if (printDirection === "bookingqube") {
    return Math.max(0, Math.round(PRINTABLE_LENGTH_DOTS - previewX - elementLength + (printStartOffset || 0)));
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
    ctx.fillText(normalizeCode39Value(value), x + (cx - x) / 2, y + barHeight + 2, Math.max(1, cx - x));
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
    return total + CODE39_PATTERNS[char].split("").reduce((sum, mark) => sum + (mark === "w" ? wide : narrow), 0) + narrow;
  }, 0);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = patternWidth + quiet * 2;
  canvas.height = barHeight + 24;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawCode39ToCanvas(ctx, value, quiet, 0, { narrow, wide, barHeight, textHeight: 24, drawText: true });

  return canvasToEplGraphic(canvas, el.x, el.y, orientation, { invert: true, lengthOffset });
}

function code39ToEplLines(el, printStartOffset = 0, printDirection = "bookingqube") {
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
        const printerY = mapPreviewLengthToPrinterY(segmentX, shouldFlip ? segmentWidth : 0, printStartOffset, printDirection);
        lines.push(`LO${printerX},${printerY},${barHeight},${segmentWidth}`);
      }
      cx += segmentWidth;
    }
    cx += narrow;
  }

  const textX = Math.round(el.y + barHeight + 4);
  const textY = mapPreviewLengthToPrinterY(Math.round(el.x + quiet + 8), 0, printStartOffset, printDirection);
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
        lines.push(`LO${originX + col * moduleSize},${originY + row * moduleSize},${moduleSize},${moduleSize}`);
      }
    }
  }

  return lines;
}

function qrToPreviewMappedEplLines(value, previewX, previewY, printStartOffset = 0, moduleSize = 4, printDirection = "opposite") {
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
        const printerY = mapPreviewLengthToPrinterY(previewModuleX, printDirection === "bookingqube" ? moduleSize : 0, printStartOffset, printDirection);
        lines.push(`LO${printerX},${printerY},${moduleSize},${moduleSize}`);
      }
    }
  }

  return lines;
}

function mediaCommand(labelLength) {
  return `Q${labelLength},0`;
}

function buildBasicEPL2({
  elements,
  logoImg = null,
  darkness = 14,
  speed = 2,
  labelLength = DEFAULT_LABEL_LENGTH_DOTS,
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
  lines.push(mediaCommand(labelLength));

  if (logoImg) {
    logoEls.forEach((el) => {
      const flipX = printDirection === "bookingqube";
      const adjustedEl = flipX
        ? { ...el, x: PRINTABLE_LENGTH_DOTS - el.x - (el.w || 80) }
        : el;
      lines.push(imageToEplGraphic(logoImg, adjustedEl, "horizontal", printStartOffset, { flipX, invert: true }));
    });
  }

  textEls.forEach((el) => {
    const font = el.font || 3;
    const hm = el.hm || 1;
    const vm = el.vm || 1;
    const flipToArtwork = printDirection === "bookingqube";
    const x = Math.max(0, Math.round(el.y + (flipToArtwork ? estimateEplTextHeight(font, vm) : 0)));
    const y = mapPreviewLengthToPrinterY(el.x, 0, printStartOffset, printDirection);
    lines.push(`A${x},${y},${flipToArtwork ? 3 : 1},${font},${hm},${vm},N,"${el.value || ""}"`);
  });

  if (barcodeEl) {
    if (codeType === "qr") {
      lines.push(...qrToPreviewMappedEplLines(barcodeEl.value, barcodeEl.x, barcodeEl.y, printStartOffset, 4, printDirection));
    } else if (barcodeMode === "lines" && barcodeRotation === 1) {
      lines.push(...code39ToEplLines(barcodeEl, printStartOffset, printDirection));
    } else {
      const flipToArtwork = printDirection === "bookingqube";
      const x = Math.max(0, Math.round(barcodeEl.y));
      const y = mapPreviewLengthToPrinterY(barcodeEl.x, 0, printStartOffset, printDirection);
      lines.push(`B${x},${y},${flipToArtwork ? 3 : barcodeRotation},3,2,5,${barcodeEl.height || barcodePrintHeight},B,"${normalizeCode39Value(barcodeEl.value)}"`);
    }
  }

  lines.push(`P${Math.max(1, Math.round(copies || 1))}`);
  return `${lines.join("\r\n")}\r\n`;
}

function mapElementToPrinter(el, orientation) {
  if (orientation !== "horizontal") return { x: Math.round(el.x), y: Math.round(el.y), rotation: el.rotation || 0 };
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
      lines.push(`A${mapped.x},${y},${mapped.rotation},${el.font || 3},${el.hm || 1},${el.vm || 1},N,"${el.value}"`);
    } else if (el.type === "barcode") {
      if (orientation === "horizontal") {
        lines.push(...code39ToEplLines(el, printStartOffset));
      } else {
        lines.push(`B${mapped.x},${y},${mapped.rotation},3,2,5,${el.height || 80},B,"${normalizeCode39Value(el.value)}"`);
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
        ctx.fillRect(x + quiet + col * moduleSize, y + quiet + row * moduleSize, moduleSize, moduleSize);
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
        drawCode39ToCanvas(ctx, el.value || "0000000", el.x, el.y, { barHeight: el.height || 80 });
      }
    } else if (el.type === "logo" && logoImg) {
      const w = el.w || 80, h = el.h || 40;
      ctx.drawImage(logoImg, el.x, el.y, w, h);
    }
    ctx.restore();
  });
}

// ── Default element set ───────────────────────────────────────────────────────
// Horizontal designer area: 1358 long × 203 wide (17 cm × 1")
const DEFAULT_ELEMENTS = [
  { id: "logo",    type: "logo",    label: "Logo",    x: 40,  y: 24,  w: 170, h: 70 },
  { id: "name",    type: "text",    label: "Name",    value: "John Doe",    x: 260, y: 42,  font: 3, hm: 1, vm: 1 },
  { id: "id",      type: "text",    label: "ID",      value: "ID: 00123",   x: 260, y: 92,  font: 2, hm: 1, vm: 1 },
  { id: "barcode", type: "barcode", label: "Barcode", value: "1234567890",  x: 520, y: 38, height: 50 },
];

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

  const selectedPrinter = () => printers.find((name) => /zebra.*raw|raw.*zebra/i.test(name)) || printer;

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
        const preferred = (data.printers || []).find((name) => /raw/i.test(name)) || data.suggested;
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
    setElements((els) => els.map((el) => (el.id === id ? { ...el, [field]: value } : el)));
  };

  const clampDesignPoint = (x, y) => ({
    x: Math.max(0, Math.min(PRINTABLE_LENGTH_DOTS, Math.round(x))),
    y: Math.max(0, Math.min(BAND_WIDTH_DOTS, Math.round(y))),
  });

  // Canvas drag handling
  const getElAtPos = (x, y) => {
    return [...elements].reverse().find((el) => {
      const w = el.type === "text" ? 180 : el.type === "barcode" ? 160 : el.w || 80;
      const h = el.type === "text" ? 30 : el.type === "barcode" ? (el.height || 80) + 20 : el.h || 40;
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
    const next = clampDesignPoint((e.clientX - rect.left) * scaleX - dragOffset.x, (e.clientY - rect.top) * scaleY - dragOffset.y);
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
      alert("No printer connected.\n\nEPL2 that would be sent:\n\n" + previewEpl);
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

  const selEl = elements.find((e) => e.id === selected);

  const statusColor = {
    disconnected: "#94a3b8",
    connecting: "#f59e0b",
    connected: "#22c55e",
    error: "#ef4444",
  }[printerStatus];

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>⬛</div>
          <div>
            <div style={styles.headerTitle}>Wristband Studio</div>
            <div style={styles.headerSub}>Zebra LP2824 · EPL2</div>
          </div>
        </div>
        <div style={styles.printerStatus}>
          <div style={{ ...styles.dot, background: statusColor }} />
          <span style={{ color: statusColor, fontSize: 13 }}>{printerMsg || "Not connected"}</span>
          <button style={styles.connectBtn} onClick={connectPrinter}>
            {printerStatus === "connected" ? "Reconnect" : "Connect Printer"}
          </button>
          <button
            style={{ ...styles.connectBtn, ...styles.clearBtn }}
            onClick={clearPrinterJobs}
            disabled={!printer || clearing}
          >
            {clearing ? "Clearing..." : "Clear Jobs"}
          </button>
        </div>
      </header>

      <div style={styles.body}>
        {/* LEFT: Canvas preview */}
        <div style={styles.previewPanel}>
          <div style={styles.panelLabel}>Live Preview <span style={styles.hint}>(drag elements)</span></div>
          <div style={styles.canvasWrap}>
            <canvas
              ref={canvasRef}
              width={PRINTABLE_LENGTH_DOTS}
              height={BAND_WIDTH_DOTS}
              style={styles.canvas}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
            />
          </div>
          <div style={styles.canvasMeta}>1358 × 203 px · 17 cm × 1" printable · 203 dpi</div>
        </div>

        {/* RIGHT: Controls */}
        <div style={styles.controlPanel}>

          {/* Printer setup notice */}
          <div style={styles.setupCard}>
            <div style={styles.setupTitle}>📋 Setup (one-time)</div>
            <ol style={styles.setupList}>
              <li>Plug in LP2824 via USB</li>
              <li>Open <b>System Settings → Printers & Scanners</b> and add it if not listed</li>
              <li>Run <code style={styles.code}>npm start</code> in the project folder</li>
              <li>Click <b>Connect Printer</b> above</li>
            </ol>
          </div>

          <Section title="Printer">
            <Row label="Queue">
              <select
                style={{ ...styles.select, flex: 1 }}
                value={printer || ""}
                onChange={(e) => {
                  setPrinter(e.target.value || null);
                  if (e.target.value) {
                    setPrinterStatus("connected");
                    setPrinterMsg(`Connected: ${e.target.value}`);
                  }
                }}
              >
                <option value="">Select printer</option>
                {printers.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </Row>
            <button style={styles.connectBtn} onClick={connectPrinter}>
              Refresh Printers
            </button>
          </Section>

          {/* Logo */}
          <Section title="Logo / Image">
            <label style={styles.uploadLabel}>
              <input type="file" accept="image/*" onChange={handleLogoUpload} style={{ display: "none" }} />
              {logoFile ? `✅ ${logoFile.name}` : "📁 Upload logo image"}
            </label>
            {logoImg && (
              <Row label="Size">
                <input type="range" min={20} max={200} value={elements.find(e=>e.id==="logo")?.w||80}
                  onChange={e => {
                    const v = +e.target.value;
                    updateEl("logo", "w", v);
                    updateEl("logo", "h", Math.round(v * 0.5));
                  }} style={styles.slider} />
              </Row>
            )}
          </Section>

          {/* Text fields */}
          <Section title="Text Fields">
            {elements.filter(e => e.type === "text").map(el => (
              <div key={el.id} style={{ ...styles.elRow, background: selected === el.id ? "#1e293b" : "transparent" }}
                onClick={() => setSelected(el.id)}>
                <span style={styles.elLabel}>{el.label}</span>
                <input
                  style={styles.textInput}
                  value={el.value}
                  onChange={e => updateEl(el.id, "value", e.target.value)}
                  placeholder={`Enter ${el.label}`}
                />
                <div style={styles.coordRow}>
                  <CoordInput label="X" value={el.x} onChange={v => updateEl(el.id, "x", v)} />
                  <CoordInput label="Y" value={el.y} onChange={v => updateEl(el.id, "y", v)} />
                  <select style={styles.select} value={el.font} onChange={e => updateEl(el.id, "font", +e.target.value)}>
                    {[1,2,3,4,5].map(f => <option key={f} value={f}>Font {f}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </Section>

          {/* Barcode */}
          <Section title="Barcode">
            {elements.filter(e => e.type === "barcode").map(el => (
              <div key={el.id} style={{ ...styles.elRow, background: selected === el.id ? "#1e293b" : "transparent" }}
                onClick={() => setSelected(el.id)}>
                <input
                  style={styles.textInput}
                  value={el.value}
                  onChange={e => updateEl(el.id, "value", e.target.value)}
                  placeholder="Barcode value"
                />
                <div style={styles.coordRow}>
                  <CoordInput label="X" value={el.x} onChange={v => updateEl(el.id, "x", v)} />
                  <CoordInput label="Y" value={el.y} onChange={v => updateEl(el.id, "y", v)} />
                  <CoordInput label="H" value={el.height || 80} onChange={v => updateEl(el.id, "height", v)} />
                </div>
              </div>
            ))}
          </Section>

          {/* Print controls */}
          <Section title="Print">
            <Row label="Copies">
              <input type="number" min={1} max={100} value={copies}
                onChange={e => setCopies(Math.max(1, +e.target.value))}
                style={{ ...styles.textInput, width: 70 }} />
            </Row>
            <Row label="Darkness">
              <input type="range" min={1} max={15} value={darkness}
                onChange={e => setDarkness(+e.target.value)}
                style={styles.slider} />
              <span style={{ fontSize: 12, color: "#94a3b8", width: 20 }}>{darkness}</span>
            </Row>
            <Row label="Label">
              <input type="number" min={200} max={3000} value={labelLength}
                onChange={e => setLabelLength(Math.max(200, +e.target.value))}
                style={{ ...styles.textInput, width: 80 }} />
              <span style={{ fontSize: 11, color: "#64748b" }}>continuous feed pitch</span>
            </Row>
            <Row label="Start">
              <input type="number" min={-500} max={500} value={printStartOffset}
                onChange={e => setPrintStartOffset(+e.target.value)}
                style={{ ...styles.textInput, width: 80 }} />
              <span style={{ fontSize: 11, color: "#64748b" }}>print-position trim</span>
            </Row>
            <Row label="Code">
              <select style={styles.select} value={codeType} onChange={e => setCodeType(e.target.value)}>
                <option value="barcode">Barcode</option>
                <option value="qr">QR code</option>
              </select>
              <span style={{ fontSize: 11, color: "#64748b" }}>print symbol</span>
            </Row>
            <Row label="Direction">
              <select style={styles.select} value={printDirection} onChange={e => setPrintDirection(e.target.value)}>
                <option value="bookingqube">Bookingqube</option>
                <option value="opposite">Opposite</option>
              </select>
              <span style={{ fontSize: 11, color: "#64748b" }}>printed reading direction</span>
            </Row>
            <Row label="Barcode">
              <select style={styles.select} value={barcodeRotation} onChange={e => setBarcodeRotation(+e.target.value)}>
                <option value={0}>0 deg</option>
                <option value={1}>90 deg</option>
                <option value={2}>180 deg</option>
                <option value={3}>270 deg</option>
              </select>
              <span style={{ fontSize: 11, color: "#64748b" }}>rotation</span>
            </Row>
            <Row label="B Mode">
              <select style={styles.select} value={barcodeMode} onChange={e => setBarcodeMode(e.target.value)}>
                <option value="lines">Lines</option>
                <option value="native">Native</option>
              </select>
              <span style={{ fontSize: 11, color: "#64748b" }}>Lines uses EPL boxes</span>
            </Row>
            <button style={styles.printBtn} onClick={handlePrint} disabled={printing}>
              {printing ? "Sending..." : `🖨 Print ${copies} Wristband${copies > 1 ? "s" : ""}`}
            </button>
            <button style={{ ...styles.printBtn, ...styles.testPrintBtn }} onClick={handleTestPrint} disabled={printing}>
              Test Print
            </button>
            {printStatus && <div style={styles.printStatus}>{printStatus}</div>}
          </Section>

          {/* EPL2 preview */}
          <Section title="EPL2 Preview">
            <pre style={styles.epl}>
              {buildBasicEPL2({ elements, darkness, labelLength, printStartOffset, copies, codeType, printDirection, barcodeRotation, barcodeMode, barcodePrintX, barcodePrintY, barcodePrintHeight })}
            </pre>
          </Section>
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

// ── Small helpers ─────────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      {children}
    </div>
  );
}

function CoordInput({ label, value, onChange }) {
  return (
    <label style={styles.coord}>
      <span style={styles.coordLabel}>{label}</span>
      <input type="number" value={value} onChange={e => onChange(+e.target.value)}
        style={styles.coordInput} />
    </label>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  root: {
    fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
    background: "#0a0f1a",
    minHeight: "100vh",
    color: "#e2e8f0",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    background: "#0f1729",
    borderBottom: "1px solid #1e293b",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: {
    width: 36, height: 36,
    background: "linear-gradient(135deg, #3b82f6, #06b6d4)",
    borderRadius: 6,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 18,
  },
  headerTitle: { fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", color: "#f1f5f9" },
  headerSub: { fontSize: 11, color: "#64748b", letterSpacing: "0.08em" },
  printerStatus: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: "50%" },
  connectBtn: {
    marginLeft: 8,
    padding: "6px 14px",
    background: "#1e3a5f",
    border: "1px solid #3b82f6",
    borderRadius: 6,
    color: "#93c5fd",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
    letterSpacing: "0.04em",
  },
  clearBtn: {
    background: "#3f1d1d",
    border: "1px solid #ef4444",
    color: "#fecaca",
  },
  body: {
    display: "flex",
    flex: 1,
    gap: 0,
    overflow: "hidden",
  },
  previewPanel: {
    flex: 1,
    minWidth: 0,
    padding: "20px 16px",
    borderRight: "1px solid #1e293b",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "#0d1525",
  },
  panelLabel: {
    fontSize: 11,
    letterSpacing: "0.1em",
    color: "#64748b",
    textTransform: "uppercase",
    marginBottom: 12,
    alignSelf: "flex-start",
  },
  hint: { color: "#334155", fontSize: 10 },
  canvasWrap: {
    border: "1px solid #1e293b",
    borderRadius: 4,
    overflow: "hidden",
    boxShadow: "0 4px 24px #00000080",
    width: "100%",
    maxWidth: PRINTABLE_LENGTH_DOTS,
    background: "#fff",
  },
  canvas: {
    display: "block",
    width: "100%",
    height: "auto",
    cursor: "crosshair",
  },
  canvasMeta: { marginTop: 8, fontSize: 10, color: "#334155" },
  controlPanel: {
    flex: "0 0 420px",
    maxWidth: 420,
    overflowY: "auto",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  setupCard: {
    background: "#111827",
    border: "1px solid #1e3a5f",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 12,
  },
  setupTitle: { fontWeight: 700, marginBottom: 8, color: "#93c5fd" },
  setupList: { paddingLeft: 18, margin: 0, lineHeight: 1.8, color: "#94a3b8" },
  code: { background: "#1e293b", borderRadius: 3, padding: "1px 5px", color: "#22d3ee", fontFamily: "inherit" },
  section: {
    background: "#0f1729",
    border: "1px solid #1e293b",
    borderRadius: 8,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  sectionTitle: {
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#475569",
    marginBottom: 4,
    fontWeight: 700,
  },
  elRow: {
    borderRadius: 6,
    padding: "8px 6px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    transition: "background 0.15s",
  },
  elLabel: { fontSize: 11, color: "#64748b", letterSpacing: "0.06em" },
  textInput: {
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 5,
    padding: "7px 10px",
    color: "#e2e8f0",
    fontFamily: "inherit",
    fontSize: 13,
    width: "100%",
    boxSizing: "border-box",
  },
  coordRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  coord: { display: "flex", alignItems: "center", gap: 4 },
  coordLabel: { fontSize: 10, color: "#64748b", width: 14 },
  coordInput: {
    width: 58,
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 4,
    padding: "5px 6px",
    color: "#e2e8f0",
    fontFamily: "inherit",
    fontSize: 12,
  },
  select: {
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 4,
    padding: "5px 6px",
    color: "#e2e8f0",
    fontFamily: "inherit",
    fontSize: 12,
  },
  slider: { width: "100%", accentColor: "#3b82f6" },
  uploadLabel: {
    display: "block",
    padding: "10px 14px",
    background: "#1e293b",
    border: "1px dashed #334155",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "center",
    fontSize: 13,
    color: "#94a3b8",
  },
  row: { display: "flex", alignItems: "center", gap: 12 },
  rowLabel: { fontSize: 12, color: "#64748b", width: 60 },
  printBtn: {
    padding: "12px 0",
    background: "linear-gradient(135deg, #1d4ed8, #0891b2)",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "0.06em",
    cursor: "pointer",
    width: "100%",
    boxShadow: "0 4px 16px #1d4ed840",
  },
  testPrintBtn: {
    background: "#1e293b",
    border: "1px solid #334155",
    color: "#cbd5e1",
    boxShadow: "none",
  },
  printStatus: {
    textAlign: "center",
    fontSize: 13,
    padding: "8px",
    background: "#111827",
    borderRadius: 6,
    color: "#94a3b8",
  },
  epl: {
    background: "#050a14",
    border: "1px solid #1e293b",
    borderRadius: 6,
    padding: "10px 12px",
    fontSize: 10,
    color: "#22d3ee",
    overflowX: "auto",
    margin: 0,
    lineHeight: 1.6,
  },
};
