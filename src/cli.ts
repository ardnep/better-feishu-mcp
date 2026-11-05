#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { AppError, safeError, settings } from './core.js';
import { KeychainStore } from './credentials.js';
import { CALLBACK, login } from './oauth.js';
import { createServer, runtime, status, VERSION } from './server.js';

const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
  profile: { type: 'string' }, 'app-id': { type: 'string' }, 'auth-mode': { type: 'string' },
  offline: { type: 'boolean' }, 'document-images': { type: 'boolean' }, replace: { type: 'boolean' }, 'no-open': { type: 'boolean' },
  stdio: { type: 'boolean' }, 'probe-keychain': { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' },
} });
async function main() {
  if (values.version) { console.log(VERSION); return; }
  const command = positionals[0];
  if (!command || values.help) {
    console.log(`better-feishu-mcp ${VERSION}

Commands:
  login --app-id cli_... [--auth-mode pkce|confidential] [--offline] [--document-images] [--replace] [--no-open]
  status
  doctor [--probe-keychain]
  logout
  serve --stdio
  approve <operation-id>

All commands accept --profile <name>. No secrets on argv. Feishu China only.
Default authentication is PKCE; confidential is an explicit non-PKCE selection.
Writes require BETTER_FEISHU_MCP_ENABLE_WRITES=1 on the server AND local approval.
Configure callback: ${CALLBACK}`); return;
  }
  const config = settings({ ...process.env, ...(values.profile ? { BETTER_FEISHU_MCP_PROFILE: values.profile } : {}) });
  const store = new KeychainStore(config.profile); const app = runtime(config, store);
  if (command === 'serve') {
    const handle = serveStdio(() => createServer(app), {
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256_000 }), legacy: 'serve',
      onerror: () => process.stderr.write('MCP protocol/transport error; private payload omitted.\n'),
    });
    const stop = () => { void handle.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await status(app), null, 2)); return; }
  if (command === 'logout') {
    await app.sessions.logout();
    console.log('Local credentials removed. Revoke provider-side authorization separately in Feishu App authorization management.'); return;
  }
  if (command === 'doctor') {
    const loggedIn = await status(app);
    if (values['probe-keychain']) {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const entry = new AsyncEntry('better-feishu-mcp.probe', randomBytes(12).toString('hex'), { linux: { store: 'secret-service' } });
      const synthetic = randomBytes(32).toString('hex');
      try {
        await entry.setPassword(synthetic);
        if (await entry.getPassword() !== synthetic) throw new AppError('KEYCHAIN_UNAVAILABLE', 'Keychain round-trip mismatch.');
      } finally { await entry.deleteCredential(); }
    }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, keychain: 'available',
      keychainWriteProbe: !!values['probe-keychain'], callback: CALLBACK, region: 'Feishu China', ...loggedIn }, null, 2)); return;
  }
  if (command === 'login') {
    const appId = z.string().regex(/^cli_[A-Za-z0-9]+$/).parse(values['app-id'] ?? (await store.load())?.appId);
    const mode = z.enum(['pkce', 'confidential']).parse(values['auth-mode'] ?? 'pkce');
    await login({ config, store, appId, mode, offline: !!values.offline, documentImages: !!values['document-images'], replace: !!values.replace,
      onReady(url) {
        console.log(`Open this local credential form: ${url}`);
        console.log(`Registered callback must be exactly ${CALLBACK}`);
        if (mode === 'confidential') console.log('Explicit confidential-client OAuth without PKCE. No automatic fallback is enabled.');
        if (!values['no-open']) {
          const browser = process.env.BETTER_FEISHU_MCP_BROWSER;
          if (browser && !/^[A-Za-z0-9 _-]{1,64}$/.test(browser)) throw new AppError('INVALID_BROWSER', 'Invalid browser app name.');
          const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
          const args = process.platform === 'darwin' ? [...(browser ? ['-a', browser] : []), url]
            : process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
          const child = spawn(bin, args, { stdio: 'ignore', shell: false });
          child.on('error', () => console.error('Browser did not open. Use the local URL printed above.')); child.unref();
        }
      } });
    console.log('Connected. Credentials saved in OS keychain. Restart running MCP processes.'); return;
  }
  if (command === 'approve') {
    const id = positionals[1]; if (!id) throw new AppError('INVALID_ARGUMENT', 'Provide an operation ID.');
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('TRUSTED_TERMINAL_REQUIRED', 'Approval requires an interactive trusted human terminal, not piped confirmation.');
    const preview = await app.operations.inspect(id);
    console.log(JSON.stringify(preview, null, 2));
    console.log('Review the exact target/content above. For images, inspect the local files and their SHA-256/size/dimensions. Changed bytes require a new draft. Delete means recycle bin, not permanent erasure.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const expected = 'approve ' + id.slice(0, 8);
      const answer = await prompt.question(`Type ${JSON.stringify(expected)} to approve, or anything else to cancel: `);
      if (answer !== expected) { console.log('Not approved.'); return; }
      await app.operations.approve(id); console.log('Approved until expiry. The MCP may now commit this exact operation once.');
    } finally { prompt.close(); }
    return;
  }
  throw new AppError('INVALID_COMMAND', 'Unknown command. Use --help.');
}
main().catch(error => { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; });
