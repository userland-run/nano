// React-like workload: module resolution, JSX rendering, JSON processing
// Representative of a Next.js/React build + SSR scenario
const start = Date.now();

// 1) Module resolution — require chains (heavy FS)
const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');

// 2) JSON parsing — package.json processing (common in bundlers)
const pkgData = JSON.stringify({
  name: "my-react-app",
  version: "1.0.0",
  dependencies: {
    react: "^18.2.0",
    "react-dom": "^18.2.0",
    next: "^14.0.0",
    typescript: "^5.0.0",
    "@types/react": "^18.2.0",
    tailwindcss: "^3.3.0",
    eslint: "^8.0.0",
    prettier: "^3.0.0"
  },
  scripts: { build: "next build", dev: "next dev", start: "next start" }
});

// Parse/stringify cycles (simulates bundler manifest processing)
let manifest = {};
for (let i = 0; i < 200; i++) {
  const pkg = JSON.parse(pkgData);
  pkg.dependencies[`dep-${i}`] = `^${i}.0.0`;
  manifest[`pkg-${i}`] = pkg;
}
const manifestStr = JSON.stringify(manifest);

// 3) JSX-like template rendering (simulates React SSR)
function renderComponent(name, props, children) {
  const attrs = Object.entries(props)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<${name} ${attrs}>${Array.isArray(children) ? children.join('') : children}</${name}>`;
}

function renderPage(pageNum) {
  const items = [];
  for (let i = 0; i < 50; i++) {
    const item = renderComponent('li', { key: i, className: 'item' },
      renderComponent('span', { className: 'title' }, `Item ${i} on page ${pageNum}`) +
      renderComponent('p', { className: 'desc' }, `Description for item ${i}. `.repeat(3))
    );
    items.push(item);
  }

  const nav = renderComponent('nav', { className: 'navbar' }, [
    renderComponent('a', { href: '/' }, 'Home'),
    renderComponent('a', { href: '/about' }, 'About'),
    renderComponent('a', { href: '/contact' }, 'Contact'),
  ]);

  const list = renderComponent('ul', { className: 'item-list' }, items);
  const main = renderComponent('main', { id: 'content' }, nav + list);
  const head = renderComponent('head', {},
    renderComponent('title', {}, `Page ${pageNum}`) +
    renderComponent('meta', { charset: 'utf-8' }, '') +
    renderComponent('link', { rel: 'stylesheet', href: '/style.css' }, '')
  );
  return `<!DOCTYPE html>${renderComponent('html', { lang: 'en' }, head + renderComponent('body', {}, main))}`;
}

// Render 100 pages (simulates SSR batch)
const pages = [];
for (let p = 0; p < 100; p++) {
  pages.push(renderPage(p));
}

// 4) Hash computation (simulates content hashing for cache busting)
const hashes = pages.map((html, i) => {
  const h = createHash('sha256');
  h.update(html);
  return h.digest('hex');
});

// 5) Path resolution (simulates module bundler path resolution)
const modules = [];
for (let i = 0; i < 500; i++) {
  modules.push(path.resolve('/app/src/components', `Component${i}`, 'index.tsx'));
  modules.push(path.join('node_modules', `package-${i}`, 'dist', 'index.js'));
}

// 6) String manipulation (simulates template/CSS processing)
let css = '';
for (let i = 0; i < 200; i++) {
  css += `.component-${i} { display: flex; align-items: center; padding: ${i}px; }\n`;
  css += `.component-${i}:hover { background: rgba(${i % 256}, ${(i*7) % 256}, ${(i*13) % 256}, 0.1); }\n`;
}

// Minify-like operation
const minified = css.replace(/\s+/g, ' ').replace(/\s*([{}:;,])\s*/g, '$1').trim();

const elapsed = Date.now() - start;
console.log(`Pages rendered: ${pages.length}`);
console.log(`Total HTML size: ${pages.reduce((s, p) => s + p.length, 0)} bytes`);
console.log(`Manifest size: ${manifestStr.length} bytes`);
console.log(`CSS size: ${css.length} → ${minified.length} (minified)`);
console.log(`Modules resolved: ${modules.length}`);
console.log(`Hashes computed: ${hashes.length}`);
console.log(`BENCH: ${elapsed}ms`);
