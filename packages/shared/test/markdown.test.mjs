import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, safeLinkUrl } from '../dist/markdown.js';

function all(nodes) {
  return nodes.flatMap(node => [node, ...all(node.children ?? []), ...(node.items ?? []).flatMap(all)]);
}
function literal(nodes) {
  return nodes.map(node => node.value ?? (node.type === 'break' ? '\n' : literal(node.children ?? []))).join('');
}
test('inline formatting, nested emphasis, inline code and line breaks', () => {
  const nodes = all(parseMarkdown('**bold *nested*** _italic_ *also* ~~gone~~ `a < b`\nnext'));
  for (const type of ['bold', 'italic', 'strike', 'code', 'break']) assert.ok(nodes.some(node => node.type === type), type);
  assert.equal(nodes.find(node => node.type === 'bold').children[1].type, 'italic');
  assert.equal(nodes.find(node => node.type === 'code').value, 'a < b');
  assert.equal(parseMarkdown('*italic **bold***')[0].children[0].children[1].type, 'bold');
});
test('fenced code, language, quotes, unordered and ordered lists', () => {
  const nodes = parseMarkdown('```js\nconst x = "<script>";\n```\n> quoted\n> again\n- a\n- b\n1. first\n2. second');
  assert.deepEqual(nodes[0], { type: 'codeBlock', language: 'js', value: 'const x = "<script>";' });
  assert.equal(nodes[1].type, 'quote');
  assert.equal(nodes[2].ordered, false);
  assert.equal(nodes[2].items.length, 2);
  assert.equal(nodes[3].ordered, true);
});
test('safe explicit links and bare HTTP URLs', () => {
  const links = all(parseMarkdown('[web]( https://example.org/a_(b) ) [mail](MAILTO:a@example.org) https://example.org.')).filter(node => node.type === 'link');
  assert.deepEqual(links.map(node => node.href), ['https://example.org/a_(b)', 'MAILTO:a@example.org', 'https://example.org']);
});
test('HTML and unterminated syntax remain literal', () => {
  for (const value of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '**open', '*open', '_open', '~~open', '`open', '[open', '```js\nopen', '# heading', '![image](https://example.org/x.png)']) {
    assert.equal(literal(parseMarkdown(value)), value);
  }
});
test('unsafe and obfuscated links remain entirely literal', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', '//example.org', 'https://exa"mple.org', "https://exa'mple.org", 'https://example.org/<x>', 'https://example.org/\u0000x', 'https://example.org/\u00a0x', 'https:\\example.org']) {
    const source = `[x](${url})`;
    assert.equal(safeLinkUrl(url), null, url);
    assert.equal(literal(parseMarkdown(source)), source, url);
    assert.equal(all(parseMarkdown(source)).some(node => node.type === 'link'), false, url);
  }
});
test('URL quote and angle delimiters never enter link attributes', () => {
  for (const source of ['https://example.org/"onmouseover="x', "https://example.org/'x", 'https://example.org/<script>']) {
    for (const node of all(parseMarkdown(source)).filter(node => node.type === 'link')) assert.ok(!/[<>"']/.test(node.href));
    assert.equal(literal(parseMarkdown(source)), source);
  }
});
test('identity tokens stay intact, including inside emphasis and code', () => {
  const token = '@[user:01TEST] #[channel:01CHAN]';
  assert.equal(literal(parseMarkdown(token)), token);
  assert.equal(literal(parseMarkdown(`**${token}**`)), token);
  assert.equal(all(parseMarkdown('`@[user:01TEST]`')).find(node => node.type === 'code').value, '@[user:01TEST]');
});
test('pathological delimiter runs finish quickly with bounded output', { timeout: 2000 }, () => {
  for (const source of ['*'.repeat(100000), '['.repeat(100000), '*['.repeat(50000), '`['.repeat(50000)]) {
    const before = performance.now();
    const nodes = parseMarkdown(source);
    assert.ok(performance.now() - before < 1000);
    if (source[0] === '[' || source === '*'.repeat(source.length)) assert.equal(literal(nodes), source);
    assert.ok(all(nodes).length < 4096);
  }
});
test('deep nesting and thousands of formatted nodes exhaust budgets safely', { timeout: 2000 }, () => {
  let nested = 'text';
  for (let index = 0; index < 100; index++) nested = `[${nested}](https://example.org)`;
  for (const source of [nested, '**a** '.repeat(10000), '- x\n'.repeat(10000)]) {
    const nodes = parseMarkdown(source);
    assert.ok(all(nodes).length < 4096);
    const depth = node => 1 + Math.max(0, ...(node.children ?? []).map(depth), ...(node.items ?? []).flatMap(item => item.map(depth)));
    assert.ok(Math.max(...nodes.map(depth)) < 30);
  }
});
