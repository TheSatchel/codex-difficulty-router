import { installDesktop, uninstallDesktop } from '../lib/install-desktop.mjs';
try {
  console.log(JSON.stringify(process.argv.includes('--uninstall') ? await uninstallDesktop() : await installDesktop(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'DESKTOP_INSTALL_ERROR', message: error.message, details: error.details }));
  process.exitCode = 1;
}
