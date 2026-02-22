#!/usr/bin/env node
"use strict";

const net = require("net");
const { spawn } = require("child_process");

const minimist = require("minimist");
const pino = require("pino");

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.transport({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  })
);

// MODE: 1 = ASCII grayscale, 2 = Truecolor blocks (ANSI 24-bit)
// Default mode for new clients (each client can toggle with key 'm')
const MODE_DEFAULT = 2;

/*----- Settings / CLI -----*/

const argv = minimist(process.argv.slice(2), {
  alias: {
    p: "port",
    f: "fps",
    v: "video",
    w: "width",
    h: "height",
  },
  default: {
    port: 2323,
    fps: 15,
    width: 240,
    height: 135,
  },
});

const VIDEO_FLAG_PROVIDED = Object.prototype.hasOwnProperty.call(argv, "video") || Object.prototype.hasOwnProperty.call(argv, "v");

const CFG = {
  // If -v/--video is not provided, we will play ./videos playlist.
  video: argv.video,
  port: parseInt(String(argv.port), 10),
  fps: parseInt(String(argv.fps), 10),
  baseW: parseInt(String(argv.width), 10),
  baseH: parseInt(String(argv.height), 10),

  chars: " .:-=+*#%@",     // ASCII ramp (dark -> bright)
  charAspect: 2.0,         // terminal cell height/width
  dropIfBufferedOver: 1024 * 1024,
  quitKeys: ["q", "Q"],
};

if (Number.isNaN(CFG.port) || Number.isNaN(CFG.fps) || Number.isNaN(CFG.baseW) || Number.isNaN(CFG.baseH)) {
  logger.fatal({ argv }, "invalid numeric CLI args");
  process.exit(1);
}

if (VIDEO_FLAG_PROVIDED && (CFG.video === true || CFG.video === "")) {
  logger.fatal("-v/--video requires a path");
  process.exit(1);
}

/*----- Telnet + ANSI -----*/
const ESC = "\x1b";
const NL = "\n";

const TELNET = {
  IAC: 255,
  DO: 253,
  SB: 250,
  SE: 240,
  NAWS: 31,
};

const clients = new Set();

/*----- Utilities -----*/
const clampInt = (n, lo, hi) => (n < lo ? lo : (n > hi ? hi : n));

function computeFit(cols, rows) {
  const dstW = clampInt(cols | 0, 1, 10000);
  const dstH = clampInt((rows | 0) - 1, 1, 10000); // 1 row safety

  // displayed aspect = (outH/outW) * charAspect
  // target aspect = baseH/baseW
  const targetHOverW = (CFG.baseH / CFG.baseW) / CFG.charAspect;

  // Use as much width as possible without exceeding height.
  const maxWByH = Math.floor(dstH / targetHOverW);
  const outW = clampInt(Math.min(dstW, maxWByH), 1, dstW);
  const outH = clampInt(Math.min(dstH, Math.floor(outW * targetHOverW)), 1, dstH);

  const padX = Math.floor((dstW - outW) / 2);
  const padY = Math.floor((dstH - outH) / 2);

  return { dstW, dstH, outW, outH, padX, padY };
}

function parseNAWS(sock, data) {
  // IAC SB NAWS <w><w> <h><h> IAC SE
  // Be defensive: some clients send partial/odd negotiation during resize.
  try {
    for (let i = 0; i + 8 < data.length; i++) {
      if (data[i] === TELNET.IAC && data[i + 1] === TELNET.SB && data[i + 2] === TELNET.NAWS) {
        // Only trust complete sequences ending with IAC SE when present.
        if (data[i + 7] !== TELNET.IAC || data[i + 8] !== TELNET.SE) continue;

        const w = data.readUInt16BE(i + 3);
        const h = data.readUInt16BE(i + 5);
        if (w > 0 && h > 0) {
          sock.cols = w;
          sock.rows = h;
        }
      }
    }
  } catch (e) {
    // Ignore negotiation parsing errors (avoid crashing on resize).
  }
}

function textFromTelnet(data) {
  // Strip IAC bytes so telnet negotiation doesn't pollute text.
  const filtered = [];
  for (let i = 0; i < data.length; i++) if (data[i] !== TELNET.IAC) filtered.push(data[i]);
  return Buffer.from(filtered).toString("utf8");
}

function shouldQuit(data) {
  const text = textFromTelnet(data);
  for (const k of CFG.quitKeys) if (text.includes(k)) return true;
  return false;
}

/*----- Renderers -----*/
const LUT = (() => {
  const lut = new Array(256);
  for (let v = 0; v < 256; v++) {
    const idx = Math.floor((v * (CFG.chars.length - 1)) / 255);
    lut[v] = CFG.chars[idx];
  }
  return lut;
})();

function renderAscii(grayFrame, cols, rows) {
  const { dstW, dstH, outW, outH, padX, padY } = computeFit(cols, rows);
  const blank = " ".repeat(dstW) + NL;

  let out = ESC + "[H";
  for (let y = 0; y < padY; y++) out += blank;

  for (let oy = 0; oy < outH; oy++) {
    const sy = Math.floor((oy * CFG.baseH) / outH);
    const srcRow = sy * CFG.baseW;

    let line = padX ? " ".repeat(padX) : "";
    for (let ox = 0; ox < outW; ox++) {
      const sx = Math.floor((ox * CFG.baseW) / outW);
      line += LUT[grayFrame[srcRow + sx]];
    }

    const rightPad = dstW - padX - outW;
    if (rightPad > 0) line += " ".repeat(rightPad);

    out += line + NL;
  }

  const bottom = dstH - padY - outH;
  for (let y = 0; y < bottom; y++) out += blank;
  return out;
}

function renderTruecolor(rgbFrame, cols, rows) {
  const { dstW, dstH, outW, outH, padX, padY } = computeFit(cols, rows);
  const blank = " ".repeat(dstW) + NL;

  let out = ESC + "[H";
  for (let y = 0; y < padY; y++) out += blank;

  for (let oy = 0; oy < outH; oy++) {
    const sy = Math.floor((oy * CFG.baseH) / outH);

    let line = padX ? " ".repeat(padX) : "";
    let curR = -1, curG = -1, curB = -1;

    for (let ox = 0; ox < outW; ox++) {
      const sx = Math.floor((ox * CFG.baseW) / outW);
      const i = (sy * CFG.baseW + sx) * 3;
      const r = rgbFrame[i], g = rgbFrame[i + 1], b = rgbFrame[i + 2];

      if (r !== curR || g !== curG || b !== curB) {
        line += `${ESC}[48;2;${r};${g};${b}m`;
        curR = r; curG = g; curB = b;
      }
      line += " ";
    }

    line += ESC + "[0m";

    const rightPad = dstW - padX - outW;
    if (rightPad > 0) line += " ".repeat(rightPad);

    out += line + NL;
  }

  const bottom = dstH - padY - outH;
  for (let y = 0; y < bottom; y++) out += blank;
  return out;
}

function rgbToGray(rgbFrame) {
  // Fast luma approximation: (54*r + 183*g + 19*b) >> 8
  const n = CFG.baseW * CFG.baseH;
  const gray = Buffer.allocUnsafe(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const r = rgbFrame[j], g = rgbFrame[j + 1], b = rgbFrame[j + 2];
    gray[i] = (54 * r + 183 * g + 19 * b) >> 8;
    j += 3;
  }
  return gray;
}

function renderFrameForClient(rgbFrame, cols, rows, mode) {
  return (mode === 2)
    ? renderTruecolor(rgbFrame, cols, rows)
    : renderAscii(rgbToGray(rgbFrame), cols, rows);
}

/*----- ffmpeg playlist (./videos loop) -----*/
const fs = require("fs");
const path = require("path");

const VIDEO_DIR = path.resolve("./videos");

function collectVideosRecursive(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(collectVideosRecursive(fullPath));
    } else if (entry.isFile() && entry.name.match(/\.(mp4|mkv|webm|mov|avi)$/i)) {
      results.push(fullPath);
    }
  }

  return results;
}

function getVideoList() {
  // If user explicitly provided -v / --video, play only that file in loop.
  if (VIDEO_FLAG_PROVIDED && CFG.video) {
    const abs = path.resolve(CFG.video);
    if (!fs.existsSync(abs)) {
      console.error("Video file not found:", abs);
      process.exit(1);
    }
    return [abs];
  }

  // Otherwise, play all videos inside ./videos (recursive, alphabetical by path).
  if (!fs.existsSync(VIDEO_DIR)) {
    console.error("Missing ./videos directory");
    process.exit(1);
  }

  const files = collectVideosRecursive(VIDEO_DIR)
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.error("No video files found in ./videos");
    process.exit(1);
  }

  return files;
}

const PLAYLIST = getVideoList();
let currentIndex = 0;
let ff;

function startFfmpeg(videoPath) {
  // Always decode as rgb24 so clients can toggle modes without restarting ffmpeg.
  const pixFmt = "rgb24";
  const vf = `scale=${CFG.baseW}:${CFG.baseH},fps=${CFG.fps}`;

  const args = [
    "-re",
    "-i", videoPath,
    "-vf", vf,
    "-f", "rawvideo",
    "-pix_fmt", pixFmt,
    "-",
  ];

  logger.info({ video: path.basename(videoPath) }, "now playing");
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  // Hide ffmpeg output unless real error happens
  let stderrBuffer = "";
  child.stderr.on("data", (d) => {
    stderrBuffer += d.toString();
  });

  child.on("close", (code) => {
    if (code !== 0 && !shuttingDown) {
      logger.error({ code, stderr: stderrBuffer.slice(-4000) }, "ffmpeg exited with error");
    }
  });

  return child;
}

function playNext() {
  const video = PLAYLIST[currentIndex];
  currentIndex = (currentIndex + 1) % PLAYLIST.length;

  ff = startFfmpeg(video);
  attachFfmpegHandlers();
}

const bytesPerFrame = (CFG.baseW * CFG.baseH * 3); // rgb24 always

let leftover = Buffer.alloc(0);

let shuttingDown = false;
let switching = false;

function attachFfmpegHandlers() {
  ff.stdout.on("data", (chunk) => {
    let data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;

    while (data.length >= bytesPerFrame) {
      const frame = data.subarray(0, bytesPerFrame);
      data = data.subarray(bytesPerFrame);

      for (const c of clients) {
        if (c.destroyed) continue;
        if (!c.cols || !c.rows) continue;
        if (c.writableLength > CFG.dropIfBufferedOver) continue;

        try {
          const rendered = renderFrameForClient(frame, c.cols, c.rows, c.mode ?? MODE_DEFAULT);
          c.write(rendered);
        } catch (e) {
          try { c.destroy(); } catch {}
          clients.delete(c);
        }
      }
    }

    leftover = data;
  });

  ff.on("close", () => {
    leftover = Buffer.alloc(0);
    if (shuttingDown) return;
    if (switching) return;
    switching = true;
    try {
      playNext(); // automatically go to next video
    } finally {
      switching = false;
    }
  });

  ff.on("error", (e) => {
    logger.error({ err: e }, "ffmpeg error");
    process.exit(1);
  });
}

// Start first video
playNext();

/*----- Server -----*/
const server = net.createServer((sock) => {
  sock._id = `${sock.remoteAddress || "?"}:${sock.remotePort || "?"}`;
  logger.info({ client: sock._id }, "client connected");
  sock.setNoDelay(true);
  sock.mode = MODE_DEFAULT; // per-client mode
  clients.add(sock);

  // Ask client to send window size (NAWS)
  sock.write(Buffer.from([TELNET.IAC, TELNET.DO, TELNET.NAWS]));

  // Clear + home + hide cursor
  sock.write(ESC + "[2J" + ESC + "[H" + ESC + "[?25l");

  sock.on("data", (data) => {
    parseNAWS(sock, data);

    // Toggle mode with 'm' (or 'M')
    {
      const text = textFromTelnet(data);
      if (text.includes("m") || text.includes("M")) {
        const before = sock.mode;
        sock.mode = (sock.mode === 2 ? 1 : 2);
        if (before !== sock.mode) logger.info({ client: sock._id, mode: sock.mode }, "mode changed");
      }
    }

    if (shouldQuit(data)) {
      if (!sock.destroyed) sock.write(ESC + "[?25h" + NL);
      sock.end();
    }
  });

  sock.on("close", () => {
    clients.delete(sock);
    logger.info({ client: sock._id }, "client disconnected");
  });
  sock.on("error", (e) => {
    clients.delete(sock);
    logger.warn({ client: sock._id, err: e }, "client socket error");
  });
});

server.listen(CFG.port, "0.0.0.0", () => {
  logger.info({ port: CFG.port }, "telnet server listening");
  logger.info({ connect: `telnet <SERVER_IP> ${CFG.port}` }, "connect command");
  logger.info({ modeDefault: MODE_DEFAULT, fps: CFG.fps, base: `${CFG.baseW}x${CFG.baseH}`, video: CFG.video }, "settings");
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down");
  shuttingDown = true;
  for (const c of clients) if (!c.destroyed) c.write(ESC + "[?25h" + NL);
  try { ff.kill("SIGKILL"); } catch {}
  process.exit(0);
});

process.on("uncaughtException", (e) => {
  logger.fatal({ err: e }, "uncaughtException");
});

process.on("unhandledRejection", (e) => {
  logger.fatal({ err: e }, "unhandledRejection");
});
