import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { desktopCapabilities } from './desktop-capabilities.mjs';
import { codexBinary, dataDirectory, saveJSON } from './config.mjs';
import { DESKTOP_LABEL } from './desktop-service.mjs';
import { readJSON, requireValue } from './ratings.mjs';
import { VERSION } from './version.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const escapeXML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function desktopLaunchAgent({ node, script, logDirectory, searchPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${DESKTOP_LABEL}</string>
<key>ProgramArguments</key><array><string>${escapeXML(node)}</string><string>${escapeXML(script)}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXML(searchPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${escapeXML(path.join(logDirectory, 'service.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXML(path.join(logDirectory, 'service.stderr.log'))}</string>
</dict></plist>\n`;
}

async function environmentValue(name) {
  const { stdout } = await exec('/bin/launchctl', ['getenv', name], { encoding: 'utf8' });
  return stdout.trim() || null;
}

async function createRuntime(directory) {
  const names = (await readdir(path.join(root, 'lib'))).filter(name => name.endsWith('.mjs')).sort();
  const hash = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json', ...names.map(n => `lib/${n}`)]) {
    hash.update(name); hash.update(await readFile(path.join(root, name)));
  }
  const runtime = path.join(directory, `${VERSION}-${hash.digest('hex').slice(0, 16)}`);
  try { await access(path.join(runtime, '.ready.json')); return runtime; } catch {}
  await mkdir(path.join(runtime, 'lib'), { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json', ...names.map(n => `lib/${n}`)]) {
    await copyFile(path.join(root, name), path.join(runtime, name));
  }
  await exec('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runtime, timeout: 120_000 });
  await saveJSON(path.join(runtime, '.ready.json'), { version: VERSION });
  return runtime;
}

export async function installDesktop({ appPath = '/Applications/ChatGPT.app',
  codexDirectory = path.join(os.homedir(), '.codex'), stateDirectory = dataDirectory(),
  agentsDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents') } = {}) {
  requireValue(process.platform === 'darwin', 'UNSUPPORTED_PLATFORM', 'The desktop installer currently supports macOS.');
  const capabilities = await desktopCapabilities(appPath);
  const directory = path.join(codexDirectory, 'difficulty-router');
  const socketDirectory = path.join(directory, 'desktop');
  const configFile = path.join(directory, 'desktop-install.json');
  const script = path.join(directory, 'desktop-service.mjs');
  const plist = path.join(agentsDirectory, `${DESKTOP_LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const runtimeRoot = await createRuntime(path.join(stateDirectory, 'desktop-runtime'));
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await mkdir(agentsDirectory, { recursive: true });
  let previous;
  try { previous = await readJSON(configFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let live;
  try { live = await readJSON(path.join(socketDirectory, 'status.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  requireValue(!live?.running || live.appConnections === 0, 'APP_STILL_CONNECTED',
    'The new runtime is prepared. Quit the desktop app before updating its active routing service.');
  const priorEnvironment = previous?.priorEnvironment ?? {
    CODEX_APP_SERVER_WS_URL: await environmentValue('CODEX_APP_SERVER_WS_URL'),
    CODEX_APP_SERVER_FORCE_CLI: await environmentValue('CODEX_APP_SERVER_FORCE_CLI')
  };
  const endpoint = `ws+unix://${path.join(socketDirectory, 'ui.sock')}:/rpc`;
  const config = { version: VERSION, runtimeRoot, stateDirectory, socketDirectory,
    nativeBinary: codexBinary(), appPath, endpoint, plist, label: DESKTOP_LABEL,
    priorEnvironment, installedAt: new Date().toISOString() };
  await saveJSON(configFile, config);
  await writeFile(script, `// Difficulty Router desktop service. No signed app files are modified.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile), config=JSON.parse(await readFile(${JSON.stringify(configFile)},'utf8'));
process.env.CDR_RUNTIME_ROOT=config.runtimeRoot;
const {serveDesktop}=await import(pathToFileURL(path.join(config.runtimeRoot,'lib/desktop-service.mjs')).href);
const service=await serveDesktop({socketDirectory:config.socketDirectory,stateDirectory:config.stateDirectory,binary:config.nativeBinary});
await exec('/bin/launchctl',['setenv','CODEX_APP_SERVER_WS_URL',service.appEndpoint]);
await exec('/bin/launchctl',['setenv','CODEX_APP_SERVER_FORCE_CLI','0']);
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await service.close();process.exit(0);};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
`, { mode: 0o600 });
  const node = await access('/opt/homebrew/bin/node').then(() => '/opt/homebrew/bin/node', () => process.execPath);
  const searchPath = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  await writeFile(plist, desktopLaunchAgent({ node, script, logDirectory: socketDirectory, searchPath }), { mode: 0o600 });
  await exec('/usr/bin/plutil', ['-lint', plist]);
  try { await exec('/bin/launchctl', ['bootout', `${domain}/${DESKTOP_LABEL}`]); }
  catch (error) { if (!/Could not find|No such process|service not found/i.test(`${error.stderr ?? ''}${error.message}`)) throw error; }
  // launchd may acknowledge bootout before it has deregistered the label.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await exec('/bin/launchctl', ['print', `${domain}/${DESKTOP_LABEL}`]); }
    catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let bootstrapped = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await exec('/bin/launchctl', ['bootstrap', domain, plist]); bootstrapped = true; break; }
    catch (error) {
      if (attempt === 9 || error.code !== 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  requireValue(bootstrapped, 'DESKTOP_BOOTSTRAP_FAILED', 'The user-level desktop service could not be registered.');
  await exec('/bin/launchctl', ['kickstart', `${domain}/${DESKTOP_LABEL}`]);
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { status = await readJSON(path.join(socketDirectory, 'status.json')); } catch {}
    if (status?.running && status.version === VERSION && await environmentValue('CODEX_APP_SERVER_WS_URL') === endpoint) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  requireValue(status?.running && await environmentValue('CODEX_APP_SERVER_WS_URL') === endpoint,
    'DESKTOP_SERVICE_NOT_READY', `Desktop service did not become ready. Inspect ${path.join(socketDirectory, 'service.stderr.log')}.`);
  return { version: VERSION, capabilities, configFile, statusFile: path.join(socketDirectory, 'status.json'),
    runtimeRoot, endpoint, serviceRunning: true, routingEnabled: status.routingEnabled,
    currentAppRestartRequired: true, appBundleModified: false, globalCodexConfigModified: false };
}

export async function uninstallDesktop({ codexDirectory = path.join(os.homedir(), '.codex') } = {}) {
  const file = path.join(codexDirectory, 'difficulty-router', 'desktop-install.json');
  const config = await readJSON(file), domain = `gui/${process.getuid()}`;
  await exec('/bin/launchctl', ['bootout', `${domain}/${config.label}`]);
  for (const [name, value] of Object.entries(config.priorEnvironment)) {
    const current = await environmentValue(name);
    if (current !== (name === 'CODEX_APP_SERVER_WS_URL' ? config.endpoint : '0')) continue;
    if (value === null) await exec('/bin/launchctl', ['unsetenv', name]);
    else await exec('/bin/launchctl', ['setenv', name, value]);
  }
  // Preserve logs, runtime and chats. The inactive plist is removed so it does
  // not re-enable the integration on the next login.
  await import('node:fs/promises').then(fs => fs.unlink(config.plist));
  return { restored: true, appRestartRequired: true, chatsDeleted: false };
}
