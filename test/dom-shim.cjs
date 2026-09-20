// A DOM small enough to run a web-chat pane script, and no smaller. Enough to
// assert the things that matter for incremental rendering: node identity across
// renders, insertion order, focus, and value assignment.
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], childNodes: [], parentNode: null,
    dataset: {}, style: {}, attrs: {},
    _text: '', value: '', hidden: false, disabled: false, spellcheck: true,
    selectionStart: 0, selectionEnd: 0, rows: 0, placeholder: '', title: '', href: '', src: '', alt: '', loading: '',
    className: '',
    get classList() {
      const self = this;
      return {
        add: (c) => { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim(); },
        remove: (c) => { self.className = self.className.split(' ').filter(x => x && x !== c).join(' '); },
        toggle: (c, on) => { on ? self.classList.add(c) : self.classList.remove(c); },
        contains: (c) => self.className.split(' ').includes(c),
      };
    },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get childElementCount() { return this.children.length; },
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = String(v); },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(.)/g, (m, c) => c.toUpperCase())] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); this.childNodes = this.children; return c; },
    append(...cs) { cs.forEach(c => typeof c === 'string' ? this.appendChild(mkText(c)) : this.appendChild(c)); },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
      this.childNodes = this.children; return c;
    },
    insertAdjacentElement(pos, c) {
      const p = this.parentNode; if (!p) return c;
      const i = p.children.indexOf(this);
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = p; p.children.splice(pos === 'afterend' ? i + 1 : i, 0, c); p.childNodes = p.children; return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; this.childNodes = this.children; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    replaceChildren(...cs) { this.children.slice().forEach(c => c.parentNode = null); this.children = []; cs.forEach(c => this.appendChild(c)); this.childNodes = this.children; },
    setRangeText(t, a, b) { this.value = this.value.slice(0, a) + t + this.value.slice(b); },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    focus() { el.ownerRoot && (el.ownerRoot.activeElement = el); },
    blur() { if (el.ownerRoot && el.ownerRoot.activeElement === el) el.ownerRoot.activeElement = null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    // display:none measures 0, and it INHERITS — anything inside a hidden
    // ancestor measures 0 too. Modelling that is what makes "grew while hidden,
    // then revealed at height 0" reproducible instead of a story about CSS.
    get scrollHeight() {
      for (let p = this; p; p = p.parentNode) if (p.hidden) return 0;
      return Math.max(1, String(this.value || this._text || "").split("\n").length) * 18;
    },
  };
  return el;
}
function mkText(t) { const n = mkEl('#text'); n._text = t; return n; }

function makeRoot() {
  const byId = new Map();
  const root = {
    activeElement: null,
    _listeners: {},
    addEventListener(t, fn) { (root._listeners[t] = root._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = root._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { for (const fn of root._listeners[t] || []) fn(Object.assign({ preventDefault() {} }, ev)); },
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    _register: (id, el) => { el.ownerRoot = root; byId.set(id, el); return el; },
  };
  return root;
}

function install() {
  global.document = {
    createElement: (t) => mkEl(t),
    createTextNode: (t) => mkText(t),
    getElementById: () => null,
    querySelector: () => null,
  };
  // Frames are DEFERRED, the way a browser defers them: a callback queued
  // DURING a render runs after that render has finished mutating the DOM.
  // Running them inline hid a whole class of bug — a textarea that auto-sized
  // itself before renderCells hid its container measured a height it would
  // never really have had.
  const frames = [];
  global.requestAnimationFrame = (fn) => frames.push(fn);
  global.__flushFrames = () => { for (const fn of frames.splice(0)) { try { fn(); } catch {} } };
  if (!global.setTimeout.__patched) { /* real timers are fine */ }
}
module.exports = { mkEl, mkText, makeRoot, install };
