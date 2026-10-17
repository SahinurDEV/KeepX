import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync, deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "apps/web/public/downloads");

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, sum]);
}

function icon(size) {
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  const center = (size - 1) / 2;
  const radius = size * 0.46;
  const width = Math.max(1.6, size * 0.07);
  const point = (unitX, unitY) => [unitX * size, unitY * size];
  const [ax, ay] = point(0.3, 0.52);
  const [bx, by] = point(0.46, 0.68);
  const [cx, cy] = point(0.74, 0.36);
  const near = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= width;
  };
  for (let y = 0; y < size; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      if (dx * dx + dy * dy > radius * radius) continue;
      const offset = y * rowBytes + 1 + x * 4;
      const mark = near(x, y, ax, ay, bx, by) || near(x, y, bx, by, cx, cy);
      raw[offset] = mark ? 255 : 0x38;
      raw[offset + 1] = mark ? 255 : 0x69;
      raw[offset + 2] = mark ? 255 : 0xf0;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function zipFiles(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = file.data;
    const compressed = deflateRawSync(data);
    const sum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralStart = offset;
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, directory, end]);
}

function manifest(firefox) {
  const value = {
    manifest_version: 3,
    name: "KeepX",
    version: "0.1.0",
    description: "Add a task to the local KeepX inbox, or save the open tab.",
    action: { default_popup: "popup.html", default_title: "KeepX" },
    permissions: ["storage", "tabs"],
    host_permissions: ["http://127.0.0.1:3000/*"],
    icons: { 16: "icon16.png", 48: "icon48.png", 128: "icon128.png" },
  };
  if (firefox) {
    value.browser_specific_settings = { gecko: { id: "keepx@localhost", strict_min_version: "128.0" } };
  }
  return Buffer.from(JSON.stringify(value, null, 2));
}

function extensionFiles(firefox) {
  const source = path.join(root, "apps/extension/src");
  return [
    { name: "manifest.json", data: manifest(firefox) },
    { name: "popup.html", data: readFileSync(path.join(source, "popup.html")) },
    { name: "popup.css", data: readFileSync(path.join(source, "popup.css")) },
    { name: "popup.js", data: readFileSync(path.join(source, "popup.js")) },
    { name: "task.js", data: readFileSync(path.join(source, "task.js")) },
    { name: "icon16.png", data: icon(16) },
    { name: "icon48.png", data: icon(48) },
    { name: "icon128.png", data: icon(128) },
  ];
}

function gmailFiles() {
  const source = path.join(root, "apps/gmail-addon");
  return ["appsscript.json", "Code.js", "INSTALL.txt"].map((name) => ({
    name,
    data: readFileSync(path.join(source, name)),
  }));
}

const chrome = zipFiles(extensionFiles(false));
const files = {
  "KeepX-0.1.0-chrome.zip": chrome,
  "KeepX-0.1.0-edge.zip": chrome,
  "KeepX-0.1.0-firefox.xpi": zipFiles(extensionFiles(true)),
  "KeepX-0.1.0-gmail.zip": zipFiles(gmailFiles()),
};

mkdirSync(outDir, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  const destination = path.join(outDir, name);
  writeFileSync(destination, data);
  const hash = createHash("sha256").update(data).digest("hex");
  console.log(`${name} sha256:${hash}`);
}
