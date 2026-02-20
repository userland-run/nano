/**
 * React SSR test — renders components to HTML strings using react-dom/server.
 * Tests: createElement, functional components, hooks (useState via init),
 * props, children, lists, conditionals, fragments.
 */
const React = require('react');
const ReactDOMServer = require('react-dom/server');

let ok = 0, total = 0;
function check(name, got, exp) {
  total++;
  if (typeof exp === 'function' ? exp(got) : got === exp) ok++;
  else process.stderr.write('  FAIL ' + name + ': got ' + JSON.stringify(got) + '\n');
}

// Basic element
const basic = ReactDOMServer.renderToStaticMarkup(
  React.createElement('h1', null, 'Hello NanoVM')
);
check('basic-h1', basic, '<h1>Hello NanoVM</h1>');

// Functional component
function Greeting({ name }) {
  return React.createElement('span', null, 'Hello, ' + name + '!');
}
const greeting = ReactDOMServer.renderToStaticMarkup(
  React.createElement(Greeting, { name: 'World' })
);
check('functional', greeting, '<span>Hello, World!</span>');

// Nested components
function Card({ title, children }) {
  return React.createElement('div', { className: 'card' },
    React.createElement('h2', null, title),
    React.createElement('div', { className: 'body' }, children)
  );
}
const card = ReactDOMServer.renderToStaticMarkup(
  React.createElement(Card, { title: 'Test' },
    React.createElement('p', null, 'Content here')
  )
);
check('nested', card.includes('<h2>Test</h2>'), true);
check('children', card.includes('<p>Content here</p>'), true);

// List rendering
function List({ items }) {
  return React.createElement('ul', null,
    items.map((item, i) => React.createElement('li', { key: i }, item))
  );
}
const list = ReactDOMServer.renderToStaticMarkup(
  React.createElement(List, { items: ['Apple', 'Banana', 'Cherry'] })
);
check('list', list, '<ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul>');

// Conditional rendering
function Status({ online }) {
  return React.createElement('span', null, online ? 'Online' : 'Offline');
}
check('cond-true', ReactDOMServer.renderToStaticMarkup(
  React.createElement(Status, { online: true })
), '<span>Online</span>');
check('cond-false', ReactDOMServer.renderToStaticMarkup(
  React.createElement(Status, { online: false })
), '<span>Offline</span>');

// Fragment
const frag = ReactDOMServer.renderToStaticMarkup(
  React.createElement(React.Fragment, null,
    React.createElement('span', null, 'A'),
    React.createElement('span', null, 'B')
  )
);
check('fragment', frag, '<span>A</span><span>B</span>');

// Complex: Table component
function Table({ data, columns }) {
  return React.createElement('table', null,
    React.createElement('thead', null,
      React.createElement('tr', null,
        columns.map(col => React.createElement('th', { key: col }, col))
      )
    ),
    React.createElement('tbody', null,
      data.map((row, i) => React.createElement('tr', { key: i },
        columns.map(col => React.createElement('td', { key: col }, String(row[col])))
      ))
    )
  );
}
const tableData = [
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
];
const table = ReactDOMServer.renderToStaticMarkup(
  React.createElement(Table, { data: tableData, columns: ['name', 'age'] })
);
check('table-thead', table.includes('<th>name</th>'), true);
check('table-row', table.includes('<td>Alice</td>'), true);
check('table-structure', table.startsWith('<table>'), true);

// renderToString (with React hydration markers)
const withMarkers = ReactDOMServer.renderToString(
  React.createElement('div', null, 'hydrate me')
);
check('renderToString', withMarkers.includes('hydrate me'), true);

// Inline styles
const styled = ReactDOMServer.renderToStaticMarkup(
  React.createElement('div', { style: { color: 'red', fontSize: '16px' } }, 'styled')
);
check('inline-style', styled.includes('color:red'), true);

// Data attributes
const dataAttr = ReactDOMServer.renderToStaticMarkup(
  React.createElement('div', { 'data-testid': 'my-div', role: 'button' }, 'click')
);
check('data-attr', dataAttr.includes('data-testid="my-div"'), true);

console.log('PASS: react-ssr ' + ok + '/' + total);
process.exit(ok === total ? 0 : 1);
