import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.resolve(web, '../../packages/ui/src');
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const errors = [];
for (const file of [...files(path.join(web, 'src')), ...files(ui)].filter(file => /\.(tsx?|css)$/.test(file))) {
  const source = fs.readFileSync(file, 'utf8');
  const shared = file.startsWith(ui);
  if (shared || file.includes(`${path.sep}components${path.sep}`)) {
    for (const match of source.matchAll(/#[\da-f]{3,8}\b/gi)) errors.push(`${file}:${source.slice(0, match.index).split('\n').length}: Use a theme token instead of ${match[0]}`);
  }
  if (shared) continue;
  if (/window\.(alert|confirm|prompt)\s*\(/.test(source)) errors.push(`${file}: Use the shared dialog components`);
  if (!file.endsWith('.tsx')) continue;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      if (['button', 'input', 'textarea', 'select'].includes(tag)) errors.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: Use a shared component instead of <${tag}>`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Shared UI checks passed: no raw controls, browser dialogs, or component hex colours.');
