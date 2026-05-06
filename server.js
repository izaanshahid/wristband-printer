import express from "express";
import cors from "cors";
import { exec, execFile } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const app = express();
const PORT = 3001;

app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
app.use(express.json({ limit: "5mb" }));

function extractJobId(lpStdout) {
  const match = String(lpStdout || "").match(/request id is (\S+)/i);
  return match ? match[1] : null;
}

function checkJobStillQueued(jobId, callback) {
  if (!jobId) return callback(null, false);
  execFile("lpstat", ["-o", jobId], (err, stdout) => {
    callback(null, !err && stdout.includes(jobId));
  });
}

function cancelJob(jobId, callback = () => {}) {
  if (!jobId) return callback();
  execFile("cancel", [jobId], () => callback());
}

function runQueueRecovery(printer, callback) {
  execFile("cancel", ["-a", printer], () => {
    execFile("cupsenable", [printer], () => {
      execFile("cupsaccept", [printer], () => callback());
    });
  });
}

// List CUPS printers, highlighting likely Zebra ones
app.get("/api/printers", (req, res) => {
  exec("lpstat -p 2>/dev/null", (err, stdout) => {
    if (err || !stdout.trim()) {
      // Also check if the USB device is physically visible even if not in CUPS
      exec("system_profiler SPUSBDataType 2>/dev/null | grep -i zebra", (_, usbOut) => {
        const usbDetected = usbOut && usbOut.trim().length > 0;
        return res.json({
          printers: [],
          suggested: null,
          usbDetected,
          message: usbDetected
            ? "Zebra detected via USB but not added to CUPS yet. Open System Settings → Printers & Scanners → click + to add it, then try again."
            : "No printers found. Plug in your LP2824 via USB and wait a moment, then try again.",
        });
      });
      return;
    }

    const all = stdout
      .split("\n")
      .filter((l) => l.startsWith("printer "))
      .map((l) => {
        const m = l.match(/^printer (\S+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);

    const zebra = all.filter((p) => /zebra|lp28|zp4|gk4|gc4|tlp/i.test(p));
    const rawZebra = zebra.find((p) => /raw/i.test(p));
    const suggested = rawZebra || zebra[0] || all[0] || null;

    res.json({ printers: all, zebraPrinters: zebra, suggested, message: null });
  });
});

// Clear queued jobs and bring the CUPS printer queue back online
app.post("/api/clear-printer", (req, res) => {
  const { printer } = req.body;
  if (!printer) {
    return res.status(400).json({ error: "Missing printer in request body." });
  }

  execFile("lpstat", ["-o", printer], (_listErr, stdout) => {
    const jobIds = String(stdout || "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((id) => id && id.startsWith(`${printer}-`));

    const cancelNext = (index = 0) => {
      if (index >= jobIds.length) {
        return runQueueRecovery(printer, () => res.json({ ok: true, cleared: jobIds.length }));
      }
      cancelJob(jobIds[index], () => cancelNext(index + 1));
    };

    cancelNext();
  });
});

// Send EPL2 to printer via CUPS lpr (raw mode)
app.post("/api/print", (req, res) => {
  const { epl, eplBase64, printer } = req.body;
  console.log("[/api/print] request", {
    printer,
    hasEpl: Boolean(epl),
    hasEplBase64: Boolean(eplBase64),
    eplBase64Chars: eplBase64 ? eplBase64.length : 0,
  });
  if ((!epl && !eplBase64) || !printer) {
    return res.status(400).json({ error: "Missing epl/eplBase64 or printer in request body." });
  }

  const tmpFile = join(tmpdir(), `zebra_${Date.now()}.epl`);
  try {
    const payload = eplBase64 ? Buffer.from(eplBase64, "base64") : Buffer.from(epl, "binary");
    console.log("[/api/print] decoded payload", {
      bytes: payload.length,
      preview: payload.toString("binary", 0, Math.min(payload.length, 500)).replace(/\r/g, "\\r").replace(/\n/g, "\\n"),
    });
    writeFileSync(tmpFile, payload);
  } catch (e) {
    return res.status(500).json({ error: `Could not write temp file: ${e.message}` });
  }

  // Ensure the CUPS queue is active before sending
  exec(`cupsenable "${printer}" 2>/dev/null; cupsaccept "${printer}" 2>/dev/null`, () => {
    // Use cups-raw content type to bypass the Zebra EPL2 driver entirely
    // so our EPL2 commands reach the printer firmware unmodified
    execFile("lp", ["-d", printer, "-o", "raw", tmpFile], (err, stdout, stderr) => {
      try { unlinkSync(tmpFile); } catch {}
      if (err) {
        console.error("[/api/print] lp failed", { printer, stderr, message: err.message });
        return res.status(500).json({ error: `lp failed: ${stderr || err.message}` });
      }
      const jobId = extractJobId(stdout);
      console.log("[/api/print] lp accepted", { printer, jobId, stdout: stdout.trim() });
      setTimeout(() => {
        checkJobStillQueued(jobId, (_checkErr, stillQueued) => {
          console.log("[/api/print] queue check", { printer, jobId, stillQueued });
          if (stillQueued) {
            cancelJob(jobId, () => {
              runQueueRecovery(printer, () => {
                console.error("[/api/print] job remained queued and was canceled", { printer, jobId });
                res.status(500).json({
                  error: `CUPS accepted ${jobId}, but the printer did not consume it. I canceled that stuck job. The app is working; check the Zebra hardware/media/USB state, then try again.`,
                  jobId,
                });
              });
            });
            return;
          }
          console.log(`✅ Sent job to ${printer}${jobId ? ` (${jobId})` : ""}`);
          res.json({ ok: true, jobId });
        });
      }, 2500);
    });
  });
});

// Health check
app.get("/api/status", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n✅ Zebra print server running → http://localhost:${PORT}`);
  console.log("   Waiting for print jobs...\n");
});
