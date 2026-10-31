import { open } from 'node:fs/promises';
import path from 'node:path';
import { requireValue } from './ratings.mjs';

// Inspect only the currently installed app. Never modify its signed bundle.
export async function desktopCapabilities(appPath = '/Applications/ChatGPT.app') {
  const file = await open(path.join(appPath, 'Contents', 'Resources', 'app.asar'), 'r');
  try {
    const prefix = Buffer.alloc(8); await file.read(prefix, 0, 8, 0);
    const headerSize = prefix.readUInt32LE(4);
    requireValue(headerSize > 0 && headerSize < 32_000_000, 'UNKNOWN_DESKTOP_PACKAGE', 'Unrecognized desktop archive.');
    const header = Buffer.alloc(headerSize); await file.read(header, 0, headerSize, 8);
    const tree = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString('utf8'));
    const entries = [];
    function walk(node, prefix = '') {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        if (value.files) walk(value, `${prefix}${name}/`);
        else if (!value.unpacked && prefix === '.vite/build/' && name.endsWith('.js')) entries.push(value);
      }
    }
    walk(tree);
    let websocketOverride = false, unixTransport = false, preservesSettingsNotifications = false;
    for (const entry of entries) {
      const data = Buffer.alloc(entry.size); await file.read(data, 0, data.length, 8 + headerSize + Number(entry.offset));
      const source = data.toString('utf8');
      websocketOverride ||= source.includes('CODEX_APP_SERVER_WS_URL');
      unixTransport ||= source.includes('ws+unix:');
      preservesSettingsNotifications ||= source.includes('thread/settings/updated');
    }
    requireValue(websocketOverride && unixTransport, 'UNSUPPORTED_DESKTOP_BUILD', 'This installed app has no verified local WebSocket override. No app settings were changed.');
    return { appPath, websocketOverride, unixTransport, preservesSettingsNotifications,
      mechanism: 'CODEX_APP_SERVER_WS_URL', bundleModified: false };
  } finally { await file.close(); }
}
