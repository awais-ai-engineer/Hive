const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
function harness(status) {
  const sandbox = { exports: {}, process: { env: {} }, fetch: async () => ({ status, ok: status === 200, json: async () => ({ detail: 'Unavailable' }) }), Set, Headers, FormData };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox.exports;
}
for (const code of [500, 503]) test(`refresh ${code} retains identity and does not tear down a Huddle`, async () => {
  const api = harness(code); api.setSession({ access_token: 'test', user: { id: 'alice' } });
  assert.equal(await api.refreshSession(), null); assert.equal(api.currentUserId(), 'alice');
});
for (const code of [401, 403]) test(`refresh ${code} revokes identity`, async () => {
  const api = harness(code); api.setSession({ access_token: 'test', user: { id: 'alice' } });
  assert.equal(await api.refreshSession(), null); assert.equal(api.currentUserId(), undefined);
});
