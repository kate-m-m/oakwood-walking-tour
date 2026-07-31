/* Annotation overlay — shared across the constellation apps.
 * Canonical source: System Design/design-system/annotate.js, synced to each
 * app's static dir by bin/sync-design-system.sh. As of 2026-07-26 this is the
 * ONLY shared UI file left: the apps each own their own design system now, and
 * the shared "Quiet Luxury" stylesheet was retired. This tool has no design
 * opinion in it, which is why it stayed shared.
 *
 * Usage: press Ctrl+Shift+A (any platform), or load the page with
 * ?annotate=1 (or #annotate) appended to the URL. Click any component to
 * pin a note on it. "Copy" / "Download" produce a markdown report with a
 * CSS selector + text snippet per note, which Claude can act on directly.
 *
 * Zero footprint until activated: no DOM nodes, no observers, one keydown
 * listener. Notes persist in localStorage per app origin + path.
 */
(function () {
  'use strict';
  if (window.__qlaLoaded) return;
  window.__qlaLoaded = true;

  var LS_PREFIX = 'qla:';
  var pageKey = location.pathname;
  var active = false;
  var built = false;
  var items = loadKey(LS_PREFIX + pageKey);
  var ui = {};           // toolbar, layer, hoverBox, hoverLabel, panel, editor
  var editing = null;    // { item, isNew }
  var rafPending = false;
  var observer = null;

  /* ---------- storage ---------- */

  function loadKey(fullKey) {
    try { return JSON.parse(localStorage.getItem(fullKey) || '[]'); }
    catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(LS_PREFIX + pageKey, JSON.stringify(items)); }
    catch (e) { /* storage full/blocked — pins still work for this session */ }
  }

  /* ---------- selectors ---------- */

  function esc(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s)
      : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function selectorFor(el) {
    if (el.id) return '#' + esc(el.id);
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { path.unshift('#' + esc(node.id)); break; }
      var part = node.tagName.toLowerCase();
      var cls = Array.prototype.slice.call(node.classList)
        .filter(function (c) { return c.indexOf('qla-') !== 0; })
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (ch) {
          return ch.tagName === node.tagName;
        });
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      path.unshift(part);
      try {
        if (document.querySelectorAll(path.join(' > ')).length === 1) break;
      } catch (e) { /* keep walking */ }
      node = parent;
    }
    return path.join(' > ');
  }

  function snippetFor(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 80) t = t.slice(0, 77) + '…';
    return t;
  }

  function resolve(sel) {
    try {
      var found = document.querySelector(sel);
      return (found && found.getClientRects().length) ? found : null;
    } catch (e) { return null; }
  }

  /* ---------- UI scaffolding ---------- */

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  var STYLES = [
    '[data-qla]{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.4;}',
    '.qla-layer{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:2147483000;}',
    '.qla-hover{position:fixed;pointer-events:none;border:1.5px solid #9A7B4F;border-radius:3px;background:rgba(154,123,79,.08);z-index:2147483001;display:none;}',
    '.qla-hoverlabel{position:fixed;pointer-events:none;background:#2B2723;color:#F7F5F1;padding:2px 8px;border-radius:4px;font-size:11px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:2147483002;display:none;}',
    '.qla-pin{position:fixed;pointer-events:auto;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#9A7B4F;color:#fff;border:2px solid #F7F5F1;box-shadow:0 1px 4px rgba(0,0,0,.35);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483003;user-select:none;}',
    '.qla-pin.qla-lost{display:none;}',
    '.qla-bar{position:fixed;right:16px;bottom:16px;pointer-events:auto;background:#2B2723;color:#F7F5F1;border-radius:999px;padding:8px 10px 8px 16px;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,.3);z-index:2147483004;}',
    '.qla-bar .qla-dot{width:8px;height:8px;border-radius:50%;background:#9A7B4F;flex:none;}',
    '.qla-bar .qla-msg{white-space:nowrap;}',
    '.qla-btn{background:rgba(247,245,241,.12);color:#F7F5F1;border:none;border-radius:999px;padding:5px 12px;font-size:12px;cursor:pointer;}',
    '.qla-btn:hover{background:rgba(247,245,241,.22);}',
    '.qla-panel{position:fixed;right:16px;bottom:64px;width:340px;max-height:min(60vh,520px);overflow:auto;pointer-events:auto;background:#FDFCFA;color:#2B2723;border:1px solid #E4DFD6;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px;z-index:2147483004;display:none;}',
    '.qla-panel h3{margin:0 0 8px;font-size:13px;font-weight:600;}',
    '.qla-row{display:flex;gap:8px;padding:8px 0;border-top:1px solid #EEE9DF;align-items:flex-start;}',
    '.qla-row .qla-num{flex:none;width:20px;height:20px;border-radius:50%;background:#9A7B4F;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;margin-top:1px;}',
    '.qla-row .qla-body{flex:1;min-width:0;}',
    '.qla-row .qla-c{margin:0 0 2px;word-wrap:break-word;}',
    '.qla-row .qla-sel{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#8A8378;word-break:break-all;}',
    '.qla-row .qla-lostnote{font-size:11px;color:#B0543B;}',
    '.qla-rowbtn{background:none;border:none;color:#9A7B4F;font-size:11px;cursor:pointer;padding:0 4px;}',
    '.qla-editor{position:fixed;pointer-events:auto;width:300px;background:#FDFCFA;border:1px solid #E4DFD6;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);padding:10px;z-index:2147483005;}',
    '.qla-editor .qla-target{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#8A8378;margin-bottom:6px;word-break:break-all;}',
    '.qla-editor textarea{width:100%;min-height:70px;border:1px solid #E4DFD6;border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;color:#2B2723;background:#fff;resize:vertical;}',
    '.qla-editor .qla-actions{display:flex;gap:8px;margin-top:8px;justify-content:flex-end;}',
    '.qla-editor .qla-btn{background:#9A7B4F;}',
    '.qla-editor .qla-btn.qla-ghost{background:#EEE9DF;color:#2B2723;}',
    '.qla-editor .qla-btn.qla-danger{background:#B0543B;}'
  ].join('\n');

  function build() {
    if (built) return;
    built = true;
    var style = h('style', { 'data-qla': '1' });
    style.textContent = STYLES;
    document.head.appendChild(style);

    ui.layer = h('div', { 'data-qla': '1', class: 'qla-layer' });
    ui.hoverBox = h('div', { 'data-qla': '1', class: 'qla-hover' });
    ui.hoverLabel = h('div', { 'data-qla': '1', class: 'qla-hoverlabel' });

    ui.msg = h('span', { class: 'qla-msg', text: 'Click a component to leave a note' });
    ui.listBtn = h('button', { class: 'qla-btn', text: 'List' });
    ui.copyBtn = h('button', { class: 'qla-btn', text: 'Copy' });
    ui.exitBtn = h('button', { class: 'qla-btn', text: 'Exit' });
    ui.bar = h('div', { 'data-qla': '1', class: 'qla-bar' }, [
      h('span', { class: 'qla-dot' }), ui.msg, ui.listBtn, ui.copyBtn, ui.exitBtn
    ]);

    ui.panel = h('div', { 'data-qla': '1', class: 'qla-panel' });

    ui.listBtn.addEventListener('click', togglePanel);
    ui.copyBtn.addEventListener('click', function () { copyReport(); });
    ui.exitBtn.addEventListener('click', deactivate);

    document.body.appendChild(ui.layer);
    document.body.appendChild(ui.hoverBox);
    document.body.appendChild(ui.hoverLabel);
    document.body.appendChild(ui.bar);
    document.body.appendChild(ui.panel);
  }

  /* ---------- pins ---------- */

  function pinEl(item) {
    if (item._pin) return item._pin;
    var pin = h('button', { 'data-qla': '1', class: 'qla-pin', text: '' });
    pin.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      openEditor(item, false);
    });
    ui.layer.appendChild(pin);
    item._pin = pin;
    return pin;
  }

  function repositionAll() {
    items.forEach(function (item, i) {
      var pin = pinEl(item);
      pin.textContent = String(i + 1);
      var el = resolve(item.selector);
      if (!el) { pin.classList.add('qla-lost'); item._lost = true; return; }
      item._lost = false;
      pin.classList.remove('qla-lost');
      var r = el.getBoundingClientRect();
      pin.style.left = (r.left + r.width * item.rx) + 'px';
      pin.style.top = (r.top + r.height * item.ry) + 'px';
    });
    if (editing && editing.item._pin) placeEditorNear(editing.item._pin);
  }

  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; repositionAll(); });
  }

  /* ---------- editor ---------- */

  function placeEditorNear(pin) {
    if (!ui.editor) return;
    var pr = pin.getBoundingClientRect();
    var w = 300, eh = ui.editor.offsetHeight || 160;
    var left = Math.min(Math.max(8, pr.left + 16), window.innerWidth - w - 8);
    var top = pr.top + 16;
    if (top + eh > window.innerHeight - 8) top = Math.max(8, pr.top - eh - 8);
    ui.editor.style.left = left + 'px';
    ui.editor.style.top = top + 'px';
  }

  function openEditor(item, isNew) {
    closeEditor(true);
    editing = { item: item, isNew: isNew };

    var ta = h('textarea', { placeholder: 'What should change here?' });
    ta.value = item.comment || '';
    var saveBtn = h('button', { class: 'qla-btn', text: 'Save' });
    var cancelBtn = h('button', { class: 'qla-btn qla-ghost', text: 'Cancel' });
    var delBtn = h('button', { class: 'qla-btn qla-danger', text: 'Delete' });

    ui.editor = h('div', { 'data-qla': '1', class: 'qla-editor' }, [
      h('div', { class: 'qla-target', text: item.selector + (item.snippet ? '  —  “' + item.snippet + '”' : '') }),
      ta,
      h('div', { class: 'qla-actions' }, isNew ? [cancelBtn, saveBtn] : [delBtn, cancelBtn, saveBtn])
    ]);
    document.body.appendChild(ui.editor);
    placeEditorNear(item._pin || ui.bar);
    ta.focus();

    saveBtn.addEventListener('click', function () {
      item.comment = ta.value.trim();
      if (!item.comment && editing.isNew) { removeItem(item); }
      save();
      closeEditor();
    });
    cancelBtn.addEventListener('click', function () { closeEditor(true); });
    delBtn.addEventListener('click', function () { removeItem(item); save(); closeEditor(); });
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
      e.stopPropagation();
    });
  }

  function closeEditor(discardNew) {
    if (!editing) return;
    if (discardNew && editing.isNew && !(editing.item.comment || '').trim()) {
      removeItem(editing.item);
      save();
    }
    if (ui.editor && ui.editor.parentNode) ui.editor.parentNode.removeChild(ui.editor);
    ui.editor = null;
    editing = null;
    refresh();
  }

  function removeItem(item) {
    var i = items.indexOf(item);
    if (i !== -1) items.splice(i, 1);
    if (item._pin && item._pin.parentNode) item._pin.parentNode.removeChild(item._pin);
    item._pin = null;
  }

  /* ---------- panel + report ---------- */

  function togglePanel() {
    var show = ui.panel.style.display !== 'block';
    ui.panel.style.display = show ? 'block' : 'none';
    if (show) renderPanel();
  }

  function renderPanel() {
    ui.panel.textContent = '';
    ui.panel.appendChild(h('h3', { text: 'Notes on this page (' + items.length + ')' }));
    if (!items.length) {
      ui.panel.appendChild(h('div', { text: 'No notes yet — click any component.' }));
    }
    items.forEach(function (item, i) {
      var edit = h('button', { class: 'qla-rowbtn', text: 'Edit' });
      var del = h('button', { class: 'qla-rowbtn', text: 'Delete' });
      edit.addEventListener('click', function () { openEditor(item, false); });
      del.addEventListener('click', function () { removeItem(item); save(); renderPanel(); refresh(); });
      var body = h('div', { class: 'qla-body' }, [
        h('p', { class: 'qla-c', text: item.comment || '(no comment)' }),
        h('div', { class: 'qla-sel', text: item.selector })
      ]);
      if (item._lost) body.appendChild(h('div', { class: 'qla-lostnote', text: 'Not visible on the current view — note is kept.' }));
      ui.panel.appendChild(h('div', { class: 'qla-row' }, [
        h('span', { class: 'qla-num', text: String(i + 1) }), body, edit, del
      ]));
    });
    var dl = h('button', { class: 'qla-btn', text: 'Download .md' });
    dl.style.background = '#9A7B4F';
    dl.style.marginTop = '10px';
    dl.addEventListener('click', downloadReport);
    var clear = h('button', { class: 'qla-rowbtn', text: 'Clear all notes for this app' });
    clear.style.marginLeft = '10px';
    clear.addEventListener('click', function () {
      if (!window.confirm('Delete every saved note for this app?')) return;
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(LS_PREFIX) === 0) localStorage.removeItem(k);
      });
      items.slice().forEach(removeItem);
      items = [];
      renderPanel(); refresh();
    });
    ui.panel.appendChild(dl);
    ui.panel.appendChild(clear);
  }

  function appName() {
    return (document.title || 'App').split(/[—|–-]/)[0].trim() || 'App';
  }

  function buildReport() {
    var when;
    try {
      when = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short'
      }).format(new Date()) + ' ET';
    } catch (e) { when = new Date().toISOString(); }

    var lines = ['# UI annotations — ' + appName(), '', 'Captured: ' + when, ''];
    var keys = Object.keys(localStorage)
      .filter(function (k) { return k.indexOf(LS_PREFIX) === 0; })
      .sort();
    var any = false;
    keys.forEach(function (k) {
      var path = k.slice(LS_PREFIX.length);
      var arr = (path === pageKey) ? items : loadKey(k);
      if (!arr.length) return;
      any = true;
      lines.push('## Page: ' + path, '');
      arr.forEach(function (item, i) {
        var head = (i + 1) + '. `' + item.selector + '`';
        if (item.snippet) head += ' — “' + item.snippet + '”';
        lines.push(head);
        (item.comment || '(no comment)').split('\n').forEach(function (l) {
          lines.push('   > ' + l);
        });
        lines.push('');
      });
    });
    if (!any) lines.push('(no notes)');
    return lines.join('\n');
  }

  function flash(text) {
    var old = ui.msg.textContent;
    ui.msg.textContent = text;
    setTimeout(function () { ui.msg.textContent = old; }, 1600);
  }

  function copyReport() {
    var md = buildReport();
    function fallback() {
      var ta = h('textarea', { 'data-qla': '1' });
      ta.value = md;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* no-op */ }
      document.body.removeChild(ta);
      flash(ok ? 'Copied ✓' : 'Copy failed — use Download');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(
        function () { flash('Copied ✓'); }, fallback
      );
    } else fallback();
  }

  function downloadReport() {
    var blob = new Blob([buildReport()], { type: 'text/markdown' });
    var a = h('a', {
      'data-qla': '1',
      href: URL.createObjectURL(blob),
      download: 'ui-annotations-' + appName().toLowerCase().replace(/\s+/g, '-') + '.md'
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function refresh() {
    scheduleReposition();
    if (ui.panel && ui.panel.style.display === 'block') renderPanel();
  }

  /* ---------- event capture while active ---------- */

  function isOurs(target) {
    return target && target.nodeType === 1 && !!target.closest('[data-qla]');
  }

  function onClickCapture(e) {
    if (!active) return;
    if (isOurs(e.target)) return;           // our UI handles its own clicks
    e.preventDefault();
    e.stopPropagation();
    if (editing) { closeEditor(true); return; }  // first click just dismisses
    var el = e.target;
    if (!el || el === document.documentElement || el === document.body) return;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    var item = {
      selector: selectorFor(el),
      snippet: snippetFor(el),
      rx: r.width ? (e.clientX - r.left) / r.width : 0.5,
      ry: r.height ? (e.clientY - r.top) / r.height : 0.5,
      comment: '',
      ts: new Date().toISOString()
    };
    items.push(item);
    save();
    refresh();
    openEditor(item, true);
  }

  function swallow(e) {
    if (!active || isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!active || !built) return;
    if (editing || isOurs(e.target)) {
      ui.hoverBox.style.display = 'none';
      ui.hoverLabel.style.display = 'none';
      return;
    }
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) {
      ui.hoverBox.style.display = 'none';
      ui.hoverLabel.style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    ui.hoverBox.style.display = 'block';
    ui.hoverBox.style.left = r.left + 'px';
    ui.hoverBox.style.top = r.top + 'px';
    ui.hoverBox.style.width = r.width + 'px';
    ui.hoverBox.style.height = r.height + 'px';
    ui.hoverLabel.style.display = 'block';
    ui.hoverLabel.textContent = selectorFor(el);
    ui.hoverLabel.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
    ui.hoverLabel.style.top = Math.max(4, r.top - 22) + 'px';
  }

  var CAPTURED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'];

  function activate() {
    if (active) return;
    active = true;
    build();
    ['bar', 'layer'].forEach(function (k) { ui[k].style.display = ''; });
    CAPTURED.forEach(function (t) {
      document.addEventListener(t, t === 'click' ? onClickCapture : swallow, true);
    });
    document.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', scheduleReposition, true);
    window.addEventListener('resize', scheduleReposition);
    observer = new MutationObserver(function (records) {
      // Ignore mutations inside our own overlay UI (pin/editor repositioning
      // mutates styles), or the observer re-triggers itself every frame.
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (!(t.nodeType === 1 && t.closest && t.closest('[data-qla]'))) {
          scheduleReposition();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    refresh();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    closeEditor(true);
    CAPTURED.forEach(function (t) {
      document.removeEventListener(t, t === 'click' ? onClickCapture : swallow, true);
    });
    document.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('scroll', scheduleReposition, true);
    window.removeEventListener('resize', scheduleReposition);
    if (observer) { observer.disconnect(); observer = null; }
    ['bar', 'layer', 'panel', 'hoverBox', 'hoverLabel'].forEach(function (k) {
      if (ui[k]) ui[k].style.display = 'none';
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      active ? deactivate() : activate();
    }
  });

  if (/[?&]annotate=1/.test(location.search) || location.hash === '#annotate') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', activate);
    } else {
      activate();
    }
  }
})();
