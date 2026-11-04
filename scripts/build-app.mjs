#!/usr/bin/env node
/**
 * Build Side Dock for macOS.
 *
 * Outputs:
 *   ~/Applications/Side Dock Engine.app   the real Electron app
 *   ~/Desktop/Side Dock.app               a tiny AppleScript launcher on the desktop
 *
 * Why a launcher: macOS 26+ refuses to start Ad-hoc-signed Electron bundles from
 * Finder/LaunchServices (the app exits with LSExitStatus 0), while executing the
 * same binary directly works. The launcher starts the engine via `nohup`, which
 * takes the direct-exec path and keeps normal double-click behaviour.
 *
 *   node scripts/build-app.mjs
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const engineDest = path.join(home, 'Applications', 'Side Dock Engine.app');
const launcherDest = path.join(home, 'Desktop', 'Side Dock.app');

const candidates = [
  process.env.SIDE_DOCK_ELECTRON_APP,
  path.join(home, '.dsh', 'electron', 'Electron.app'),
  '/Applications/Electron.app',
].filter(Boolean);
const electronApp = candidates.find((candidate) => existsSync(candidate));
if (!electronApp) {
  console.error('找不到 Electron。设置 SIDE_DOCK_ELECTRON_APP，或把 Electron.app 放到 /Applications。');
  process.exit(1);
}

// ---------------------------------------------------------------- engine app
function buildEngine() {
  console.log('electron:', electronApp);
  console.log('engine:  ', engineDest);
  rmSync(engineDest, { recursive: true, force: true });
  mkdirSync(path.dirname(engineDest), { recursive: true });
  execFileSync('cp', ['-R', electronApp, engineDest]);

  const resources = path.join(engineDest, 'Contents', 'Resources');
  const bundledApp = path.join(resources, 'app');
  rmSync(bundledApp, { recursive: true, force: true });
  mkdirSync(bundledApp, { recursive: true });
  cpSync(path.join(repoRoot, 'src'), path.join(bundledApp, 'src'), { recursive: true });
  writeFileSync(
    path.join(bundledApp, 'package.json'),
    JSON.stringify({ name: 'side-dock', version: '1.0.0', main: 'src/main.js' }, null, 2),
  );

  // Icon
  const iconPng = path.join(repoRoot, 'assets', 'icon.png');
  if (existsSync(iconPng) && process.platform === 'darwin') {
    try {
      const iconset = path.join(resources, 'icon.iconset');
      rmSync(iconset, { recursive: true, force: true });
      mkdirSync(iconset, { recursive: true });
      for (const [size, name] of [
        [16, 'icon_16x16'],
        [32, 'icon_16x16@2x'],
        [32, 'icon_32x32'],
        [64, 'icon_32x32@2x'],
        [128, 'icon_128x128'],
        [256, 'icon_128x128@2x'],
        [256, 'icon_256x256'],
        [512, 'icon_256x256@2x'],
        [512, 'icon_512x512'],
        [1024, 'icon_512x512@2x'],
      ]) {
        execFileSync('sips', ['-z', String(size), String(size), iconPng, '--out', path.join(iconset, name + '.png')], {
          stdio: 'ignore',
        });
      }
      execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'icon.icns')]);
      rmSync(iconset, { recursive: true, force: true });
    } catch (error) {
      console.warn('icon skipped:', error instanceof Error ? error.message : error);
    }
  }

  // Bundle identity
  const plist = path.join(engineDest, 'Contents', 'Info.plist');
  for (const [key, value, type] of [
    ['CFBundleName', 'Side Dock Engine', 'string'],
    ['CFBundleDisplayName', 'Side Dock Engine', 'string'],
    ['CFBundleIdentifier', 'com.swingmonkey.side-dock-engine', 'string'],
    ['CFBundleShortVersionString', '1.0.0', 'string'],
    ['CFBundleVersion', '1.0.0', 'string'],
    ['CFBundleIconFile', 'icon.icns', 'string'],
  ]) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' });
    } catch {
      try {
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist], { stdio: 'ignore' });
      } catch {
        /* key already present with odd type */
      }
    }
  }

  try {
    execFileSync('xattr', ['-cr', engineDest], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', engineDest], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

// -------------------------------------------------------------- launcher app
function buildLauncher() {
  const engineBinary = path.join(engineDest, 'Contents', 'MacOS', 'Electron');
  // `launchctl submit` runs the engine as a launchd job, so it survives the
  // launcher exiting (a plain `nohup &` child is reaped with the shell session).
  const script = [
    'on run',
    '  set enginePath to ' + JSON.stringify(engineBinary),
    '  do shell script "launchctl remove com.swingmonkey.side-dock >/dev/null 2>&1; launchctl submit -l com.swingmonkey.side-dock -- " & quoted form of enginePath',
    'end run',
    '',
  ].join('\n');
  const scriptFile = path.join(os.tmpdir(), 'side-dock-launcher.applescript');
  writeFileSync(scriptFile, script);
  rmSync(launcherDest, { recursive: true, force: true });
  execFileSync('osacompile', ['-o', launcherDest, scriptFile]);
  rmSync(scriptFile, { force: true });

  // App icon + display name for the launcher.
  const launcherResources = path.join(launcherDest, 'Contents', 'Resources');
  const iconPng = path.join(repoRoot, 'assets', 'icon.png');
  if (existsSync(iconPng)) {
    try {
      const iconset = path.join(os.tmpdir(), 'side-dock-launcher.iconset');
      rmSync(iconset, { recursive: true, force: true });
      mkdirSync(iconset, { recursive: true });
      for (const [size, name] of [
        [16, 'icon_16x16'],
        [32, 'icon_16x16@2x'],
        [32, 'icon_32x32'],
        [64, 'icon_32x32@2x'],
        [128, 'icon_128x128'],
        [256, 'icon_128x128@2x'],
        [256, 'icon_256x256'],
        [512, 'icon_256x256@2x'],
        [512, 'icon_512x512'],
        [1024, 'icon_512x512@2x'],
      ]) {
        execFileSync('sips', ['-z', String(size), String(size), iconPng, '--out', path.join(iconset, name + '.png')], {
          stdio: 'ignore',
        });
      }
      execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(launcherResources, 'applet.icns')]);
      rmSync(iconset, { recursive: true, force: true });
    } catch (error) {
      console.warn('launcher icon skipped:', error instanceof Error ? error.message : error);
    }
  }
  const plist = path.join(launcherDest, 'Contents', 'Info.plist');
  for (const [key, value] of [
    ['CFBundleName', 'Side Dock'],
    ['CFBundleDisplayName', 'Side Dock'],
    ['CFBundleIdentifier', 'com.swingmonkey.side-dock-launcher'],
  ]) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' });
    } catch {
      /* keep the osacompile default */
    }
  }
  try {
    execFileSync('xattr', ['-cr', launcherDest], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
  console.log('launcher:', launcherDest);
}

buildEngine();
buildLauncher();
console.log('\n完成：双击桌面的 “Side Dock” 启动；引擎在 ~/Applications/Side Dock Engine.app');
