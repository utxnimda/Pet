const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, 'patch-v12.js');
const source = fs.readFileSync(target, 'utf8');
const oldText = "  '      const data = await response.json();',";
const newText = "  '    const data = await response.json();',";

if (source.split(oldText).length - 1 !== 1) {
  throw new Error('Expected exactly one indentation fix target.');
}

fs.writeFileSync(target, source.replace(oldText, newText), 'utf8');
