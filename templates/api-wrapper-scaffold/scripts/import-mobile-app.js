#!/usr/bin/env node
/**
 * import-mobile-app.js - guided importer for mobile-app traffic (issue #44).
 *
 * Companion to the api-wrapper-scaffold agent's Phase 1.5 (Mobile App
 * Discovery). When the user opts in to mobile capture, this script:
 *
 *   1. Prints step-by-step instructions for the chosen platform/mode combo:
 *      - Mode A: proxy capture (mitmproxy / Charles) -> HAR file.
 *      - Mode B: decompile (jadx / class-dump) -> static endpoint list.
 *   2. In interactive mode (default) waits for the user to confirm "done".
 *   3. Validates that the expected output file(s) exist under
 *      Samples/HAR-Original/ or Samples/MobileApp-Discovered/.
 *
 * This script never invokes proxies / decompilers itself. Decompilation
 * MUST only be performed against apps you are legally permitted to inspect
 * (your own account, or where the target ToS permits security research) -
 * a warning is printed before any decompile instructions.
 *
 * Flags (all optional except --platform and --mode in non-interactive use):
 *   --platform=ios|android|both
 *   --mode=proxy|decompile|both
 *   --non-interactive          Print full instruction set and exit 0.
 *   --validate-only            Skip instructions; only run the existence check.
 *   --har-dir=<path>           Override default Samples/HAR-Original/ for
 *                              validation (test hook).
 *   --discovered-dir=<path>    Override Samples/MobileApp-Discovered/.
 *
 * Exit codes: 0 success; 1 validation failure; 2 usage error.
 *
 * Usage: node import-mobile-app.js --platform=android --mode=proxy
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const VALID_PLATFORMS = new Set(['ios', 'android', 'both']);
const VALID_MODES     = new Set(['proxy', 'decompile', 'both']);

function parseArgs(argv) {
  const args = {
    platform: null,
    mode: null,
    nonInteractive: false,
    validateOnly: false,
    harDir: null,
    discoveredDir: null,
  };
  for (const a of argv) {
    if (a === '--non-interactive')       args.nonInteractive = true;
    else if (a === '--validate-only')    args.validateOnly   = true;
    else if (a.startsWith('--platform=')) args.platform = a.slice('--platform='.length).toLowerCase();
    else if (a.startsWith('--mode='))     args.mode     = a.slice('--mode='.length).toLowerCase();
    else if (a.startsWith('--har-dir=')) args.harDir   = a.slice('--har-dir='.length);
    else if (a.startsWith('--discovered-dir=')) args.discoveredDir = a.slice('--discovered-dir='.length);
    else {
      process.stderr.write(`error: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function validatePlatformMode(args) {
  if (!args.platform || !VALID_PLATFORMS.has(args.platform)) {
    process.stderr.write(`error: --platform must be one of ios|android|both (got ${args.platform})\n`);
    process.exit(2);
  }
  if (!args.mode || !VALID_MODES.has(args.mode)) {
    process.stderr.write(`error: --mode must be one of proxy|decompile|both (got ${args.mode})\n`);
    process.exit(2);
  }
}

function expandPlatforms(p) {
  return p === 'both' ? ['android', 'ios'] : [p];
}

function expandModes(m) {
  return m === 'both' ? ['proxy', 'decompile'] : [m];
}

const LEGAL_WARNING =
  'LEGAL: Only decompile or proxy-intercept apps you are legally permitted ' +
  'to inspect (your own account, or where the target Terms of Service ' +
  'permit security research). You are responsible for compliance.';

function printProxyInstructions(platform) {
  const lines = [];
  lines.push(`=== ${platform.toUpperCase()} :: proxy capture (mitmproxy / Charles Proxy) ===`);
  lines.push('');
  lines.push('1. Install mitmproxy on the host machine:');
  lines.push('   - macOS:   brew install mitmproxy');
  lines.push('   - Windows: winget install mitmproxy.mitmproxy');
  lines.push('   - Linux:   pipx install mitmproxy');
  lines.push('   (Charles Proxy is an equivalent commercial alternative.)');
  lines.push('');
  lines.push('2. Start mitmproxy in HAR-export mode:');
  lines.push('   mitmweb --set hardump=./Samples/HAR-Original/' +
             `mobile-${platform}-$(date +%Y%m%dT%H%M%SZ).har`);
  lines.push('   (mitmweb listens on http://127.0.0.1:8080 by default.)');
  lines.push('');
  lines.push('3. Install the mitmproxy CA certificate on the device.');
  if (platform === 'android') {
    lines.push('   Android:');
    lines.push('   a. On the device, connect Wi-Fi to the same network as the host.');
    lines.push('   b. Set the Wi-Fi proxy to <host-ip>:8080.');
    lines.push('   c. Open http://mitm.it in the device browser and install the CA certificate.');
    lines.push('   d. Settings -> Security -> Encryption & credentials ->');
    lines.push('      Install a certificate -> CA certificate. Confirm the warning.');
    lines.push('   e. For apps targeting Android 7+ with strict network-security config:');
    lines.push('      either use a rooted device + Magisk MoveCertificates module,');
    lines.push('      or use a debug build of the app, or fall back to --mode=decompile.');
  } else {
    lines.push('   iOS:');
    lines.push('   a. On the device, connect Wi-Fi to the same network as the host.');
    lines.push('   b. Settings -> Wi-Fi -> (i) on the network -> Configure Proxy -> Manual.');
    lines.push('      Server: <host-ip>, Port: 8080.');
    lines.push('   c. Safari to http://mitm.it -> download iOS CA profile.');
    lines.push('   d. Settings -> General -> VPN & Device Management -> install the profile.');
    lines.push('   e. Settings -> General -> About -> Certificate Trust Settings ->');
    lines.push('      toggle ON for the mitmproxy root certificate. This is required.');
  }
  lines.push('');
  lines.push(`4. Launch the target app on the ${platform} device and exercise the flows`);
  lines.push('   you want the wrapper to cover (login, list, detail, mutation).');
  lines.push('');
  lines.push('5. In mitmweb, File -> Save -> HAR. The script expects the resulting file at:');
  lines.push(`     Samples/HAR-Original/mobile-${platform}-<timestamp>.har`);
  lines.push('');
  lines.push('6. After saving, re-run this script with --validate-only to confirm,');
  lines.push('   then proceed to sanitize-har.js + verify-scrub.js (same scrub');
  lines.push('   pipeline as web HARs - PR #37).');
  return lines.join('\n');
}

function printDecompileInstructions(platform) {
  const lines = [];
  lines.push(`=== ${platform.toUpperCase()} :: decompile (static endpoint discovery) ===`);
  lines.push('');
  lines.push(LEGAL_WARNING);
  lines.push('');
  if (platform === 'android') {
    lines.push('1. Connect the Android device via USB; enable USB debugging.');
    lines.push('2. Find the package path:');
    lines.push('     adb shell pm path com.example.targetapp');
    lines.push('3. Pull the APK:');
    lines.push('     adb pull /data/app/.../base.apk ./targetapp.apk');
    lines.push('4. Decompile with jadx:');
    lines.push('     jadx -d ./targetapp-decompiled ./targetapp.apk');
    lines.push('5. Grep decompiled sources for URL strings:');
    lines.push('     grep -rEho \'https?://[A-Za-z0-9._/?=&%~-]+\' ./targetapp-decompiled \\');
    lines.push('       | sort -u > Samples/MobileApp-Discovered/android-endpoints.txt');
  } else {
    lines.push('1. Obtain a decrypted IPA (e.g. via frida-ios-dump on a jailbroken device,');
    lines.push('   or by extracting from your own Apple Developer account).');
    lines.push('2. Unzip the IPA and locate Payload/<App>.app/<App>:');
    lines.push('     unzip -q targetapp.ipa -d ./targetapp-ipa');
    lines.push('3. Dump Objective-C class headers with class-dump (or Hopper Disassembler');
    lines.push('   for Swift symbols):');
    lines.push('     class-dump -H ./targetapp-ipa/Payload/Target.app/Target -o ./targetapp-headers');
    lines.push('4. Grep the binary and headers for URL strings:');
    lines.push('     strings ./targetapp-ipa/Payload/Target.app/Target \\');
    lines.push('       | grep -Eo \'https?://[A-Za-z0-9._/?=&%~-]+\' \\');
    lines.push('       | sort -u > Samples/MobileApp-Discovered/ios-endpoints.txt');
  }
  lines.push('');
  lines.push(`The script expects the resulting URL list at:`);
  lines.push(`  Samples/MobileApp-Discovered/${platform}-endpoints.txt`);
  lines.push('');
  lines.push('After capture, the agent merges this URL list into the endpoint catalog');
  lines.push('emitted by Phase 5 (Endpoint Deduplication).');
  return lines.join('\n');
}

function printInstructions(args) {
  const out = [];
  for (const p of expandPlatforms(args.platform)) {
    for (const m of expandModes(args.mode)) {
      out.push(m === 'proxy' ? printProxyInstructions(p) : printDecompileInstructions(p));
      out.push('');
    }
  }
  process.stdout.write(out.join('\n'));
}

function defaultHarDir() {
  return path.join('Samples', 'HAR-Original');
}
function defaultDiscoveredDir() {
  return path.join('Samples', 'MobileApp-Discovered');
}

function validateOutputs(args) {
  let ok = true;
  const errors = [];
  const harDir        = args.harDir        || defaultHarDir();
  const discoveredDir = args.discoveredDir || defaultDiscoveredDir();
  const modes     = expandModes(args.mode);
  const platforms = expandPlatforms(args.platform);

  for (const p of platforms) {
    if (modes.includes('proxy')) {
      const pattern = new RegExp(`^mobile-${p}-.*\\.har$`, 'i');
      let entries = [];
      try { entries = fs.readdirSync(harDir); } catch { /* missing dir handled below */ }
      const matches = entries.filter((e) => pattern.test(e));
      if (matches.length === 0) {
        ok = false;
        errors.push(`no proxy-capture HAR found matching mobile-${p}-*.har under ${harDir}`);
      } else {
        process.stdout.write(`OK proxy: ${path.join(harDir, matches[0])}\n`);
      }
    }
    if (modes.includes('decompile')) {
      const expected = path.join(discoveredDir, `${p}-endpoints.txt`);
      if (!fs.existsSync(expected)) {
        ok = false;
        errors.push(`no decompile endpoint list found at ${expected}`);
      } else {
        process.stdout.write(`OK decompile: ${expected}\n`);
      }
    }
  }

  if (!ok) {
    for (const e of errors) process.stderr.write(`error: ${e}\n`);
    process.exit(1);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  validatePlatformMode(args);

  if (args.validateOnly) {
    validateOutputs(args);
    process.exit(0);
  }

  printInstructions(args);

  if (args.nonInteractive) {
    process.exit(0);
  }

  // Interactive mode: prompt the user to signal "done", then validate.
  process.stdout.write('\n[interactive] Press ENTER once capture is complete to validate outputs... ');
  process.stdin.resume();
  process.stdin.once('data', () => {
    validateOutputs(args);
    process.exit(0);
  });
}

module.exports = {
  parseArgs,
  printProxyInstructions,
  printDecompileInstructions,
  validateOutputs,
};

if (require.main === module) {
  main(process.argv.slice(2));
}