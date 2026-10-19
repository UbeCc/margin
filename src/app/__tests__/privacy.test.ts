// pref.privacy (parity ledger): Margin sends no telemetry by construction and keeps network access
// local-only (network-updates-privacy §5). This audits the shipped configuration and sources.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';

const repo = join(__dirname, '../../..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|rs)$/.test(n) && !/(\.test\.ts|_tests\.rs)$/.test(n) ? [p] : [];
  });

describe('pref.privacy: Privacy/security toggles (no telemetry; local-only network)', () => {
  it('pref.privacy: no telemetry setting, no beacon/analytics code, CSP keeps fetch/XHR local', () => {
    // No usage-info / crash-report / auto-update switches exist.
    const keys = Object.keys(DEFAULT_SETTINGS).join(' ');
    expect(keys).not.toMatch(/usage|telemetry|analytics|sentry|crash|autoUpdate|checkUpdate/i);

    // Sources (frontend + native) contain no telemetry SDKs or beacons.
    const files = [...walk(join(repo, 'src')), ...walk(join(repo, 'src-tauri/src'))];
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/sendBeacon|[Ss]entry|google-analytics|googletagmanager|[Mm]ixpanel|segment\.io|[Pp]ost[Hh]og|appcast|\bSparkle\b|SUUpdater/);
    }

    // The webview CSP only lets scripts talk to the app itself (IPC + asset protocol): no remote connect-src.
    const conf = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'));
    const connect: string = conf.app.security.csp['connect-src'];
    expect(connect.split(/\s+/).sort()).toEqual(['asset:', 'http://asset.localhost', 'http://ipc.localhost', 'ipc:']);
    expect(conf.app.security.csp['script-src']).toBe("'self'");
    expect(conf.plugins?.updater).toBeUndefined();
  });
});
