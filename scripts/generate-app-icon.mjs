#!/usr/bin/env node
/**
 * Generate app-icon.svg from logo-mark-assets.json (single source of truth).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = JSON.parse(
  readFileSync(join(root, "src/lib/logo-mark-assets.json"), "utf8"),
);
const { shapes, appIcon } = assets;
const { backPage, frontPage, dot } = shapes;

const transform = `translate(${appIcon.center} ${appIcon.center}) scale(${appIcon.scale}) translate(-${appIcon.markCenter} -${appIcon.markCenter})`;

const svg = `<svg width="${appIcon.size}" height="${appIcon.size}" viewBox="0 0 ${appIcon.size} ${appIcon.size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${appIcon.size}" height="${appIcon.size}" rx="${appIcon.cornerRadius}" fill="${appIcon.background}"/>
  <g transform="${transform}">
    <rect x="${backPage.x}" y="${backPage.y}" width="${backPage.width}" height="${backPage.height}" rx="${backPage.rx}" fill="${appIcon.accent}" opacity="${backPage.opacity}"/>
    <rect x="${frontPage.x}" y="${frontPage.y}" width="${frontPage.width}" height="${frontPage.height}" rx="${frontPage.rx}" fill="${appIcon.accent}"/>
    <circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" fill="${appIcon.success}"/>
  </g>
</svg>
`;

writeFileSync(join(root, "app-icon.svg"), svg);
console.log("Generated app-icon.svg from logo-mark-assets.json");
