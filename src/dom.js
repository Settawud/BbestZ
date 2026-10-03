/**
 * Tiny DOM helpers. Everything goes through `textContent`, never `innerHTML` —
 * the panel renders response bodies from whatever server the page talked to,
 * and those must never be parsed as markup.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * `el('span', { class: 'x', text: 'hi' })`
 * `el('button', { onclick: fn, dataset: { id: 1 } }, child, [child, child])`
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }

  return node;
}

/** A name/value table — used for headers, query params and form bodies. */
export function kvTable(pairs, { emptyText = 'None' } = {}) {
  if (!pairs?.length) return el('p', { class: 'empty-note', text: emptyText });
  return el(
    'table',
    { class: 'kv' },
    el(
      'tbody',
      null,
      pairs.map((pair) =>
        el(
          'tr',
          null,
          el('th', { text: pair.name, title: pair.name }),
          el('td', { text: pair.value }),
        ),
      ),
    ),
  );
}

/** A two-column definition list for the Overview tab. */
export function defList(rows) {
  return el(
    'dl',
    { class: 'def' },
    rows
      .filter(([, value]) => value != null && value !== '')
      .map(([label, value]) => [el('dt', { text: label }), el('dd', { text: String(value) })]),
  );
}
