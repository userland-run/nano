/**
 * Marked (Markdown parser) test — converts Markdown to HTML.
 */
const { marked } = require('marked');

let ok = 0, total = 0;
function check(name, cond) {
  total++;
  if (cond) ok++;
  else process.stderr.write('  FAIL ' + name + '\n');
}

// Headings
check('h1', marked('# Hello').trim() === '<h1>Hello</h1>');
check('h3', marked('### Sub').trim() === '<h3>Sub</h3>');

// Paragraphs
check('para', marked('Hello world').trim() === '<p>Hello world</p>');

// Bold and italic
const bold = marked('**bold**').trim();
check('bold', bold.includes('<strong>bold</strong>'));
const italic = marked('*italic*').trim();
check('italic', italic.includes('<em>italic</em>'));

// Links
const link = marked('[Google](https://google.com)').trim();
check('link', link.includes('href="https://google.com"') && link.includes('Google'));

// Code blocks
const code = marked('```js\nconsole.log("hi");\n```').trim();
check('codeblock', code.includes('<code') && code.includes('console.log'));

// Inline code
check('inline-code', marked('Use `npm install`').includes('<code>npm install</code>'));

// Lists
const ul = marked('- a\n- b\n- c').trim();
check('ul', ul.includes('<ul>') && ul.includes('<li>a</li>'));

const ol = marked('1. first\n2. second\n3. third').trim();
check('ol', ol.includes('<ol>') && ol.includes('<li>first</li>'));

// Blockquote
const bq = marked('> This is a quote').trim();
check('blockquote', bq.includes('<blockquote>'));

// Horizontal rule
const hr = marked('---').trim();
check('hr', hr.includes('<hr'));

// Image
const img = marked('![alt](img.png)').trim();
check('img', img.includes('<img') && img.includes('src="img.png"'));

// Table
const table = marked('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |').trim();
check('table', table.includes('<table>') && table.includes('<td>1</td>'));

// Complex document
const doc = `
# NanoVM Test

This is a **test** of the *markdown* parser.

## Features

- Fast parsing
- HTML output
- Code highlighting

\`\`\`javascript
const x = 42;
console.log(x);
\`\`\`

> NanoVM can run Node.js!

| Feature | Status |
|---------|--------|
| Parsing | Done   |
| Render  | Done   |
`;
const html = marked(doc);
check('doc-h1', html.includes('<h1>NanoVM Test</h1>'));
check('doc-h2', html.includes('<h2>Features</h2>'));
check('doc-bold', html.includes('<strong>test</strong>'));
check('doc-list', html.includes('<li>Fast parsing</li>'));
check('doc-code', html.includes('const x = 42'));
check('doc-table', html.includes('<td>Done</td>'));

console.log('PASS: marked ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
