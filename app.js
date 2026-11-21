/* Sherlock Reader – a simple Word-style reader with bookmarks and a vocabulary list.
   Everything is stored in this browser (localStorage). */
(function () {
  "use strict";

  // ---------- storage ----------
  const KEY = "sherlock-reader-v1";
  const defaults = {
    settings: { fontSize: 19, theme: "light", font: "serif", lang: "Vietnamese", onlyNew: false },
    last: null,          // {s: sectionId, p: paragraphId}
    bookmarks: [],       // {id, s, p, text, path, at}
    vocab: [],           // {id, word, sentence, paragraph, s, p, off, path, note, at, exported}
    furthest: {},        // sectionId -> furthest paragraph id reached
  };
  let db;
  try { db = Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || "{}")); }
  catch (e) { db = Object.assign({}, defaults); }
  db.settings = Object.assign({}, defaults.settings, db.settings);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast("Could not save – storage is full or blocked."); } };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), Math.max(2600, msg.length * 60));
  }

  // Text of a node with <br> as newline.
  function textOf(node) {
    let s = "";
    const walk = (n) => {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeName === "BR") s += "\n";
      else n.childNodes.forEach(walk);
    };
    walk(node);
    return s;
  }
  // Character offset of (container, offset) inside paragraph p.
  function offsetIn(p, container, offset) {
    const r = document.createRange();
    r.setStart(p, 0); r.setEnd(container, offset);
    return textOf(r.cloneContents()).length;
  }
  // Find DOM position for character offset inside p.
  function posAt(p, target) {
    let count = 0, found = null;
    const walk = (n) => {
      if (found) return;
      if (n.nodeType === 3) {
        const len = n.nodeValue.length;
        if (count + len >= target) { found = [n, target - count]; return; }
        count += len;
      } else if (n.nodeName === "BR") count += 1;
      else n.childNodes.forEach(walk);
    };
    walk(p);
    return found;
  }

  // Sentence that contains [start,end) inside text.
  const ABBR = /\b(Mr|Mrs|Ms|Dr|St|Sr|Jr|Co|Mt|Messrs|Col|Capt|Gen|Lt|Prof|Rev|No|vs|etc|i\.e|e\.g|M\.D|[A-Z])\.$/;
  function sentenceAround(text, start, end) {
    const isEnd = (i) => {
      // i is index of a terminator .!? ; boundary if followed by optional closing quotes then whitespace/end
      let j = i + 1;
      while (j < text.length && /["”’')\]]/.test(text[j])) j++;
      if (j < text.length && !/\s/.test(text[j])) return -1;
      if (text[i] === "." && ABBR.test(text.slice(Math.max(0, i - 8), i + 1))) return -1;
      return j;
    };
    let s = 0;
    for (let i = start - 1; i >= 0; i--) {
      if (text[i] === "\n") { s = i + 1; break; }
      if (/[.!?]/.test(text[i])) { const j = isEnd(i); if (j !== -1 && j <= start) { s = j; break; } }
    }
    let e = text.length;
    for (let i = Math.max(end, start); i < text.length; i++) {
      if (text[i] === "\n") { e = i; break; }
      if (/[.!?]/.test(text[i])) { const j = isEnd(i); if (j !== -1) { e = j; break; } }
    }
    return text.slice(s, e).replace(/\s+/g, " ").trim();
  }

  // ---------- book ----------
  let book = null, cur = -1;
  const pathText = (sec) => sec.path.join(" › ");

  async function loadBook() {
    const inline = document.getElementById("book-data");
    if (inline) return JSON.parse(inline.textContent);
    const res = await fetch("book/book.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  function renderSection(id, scrollToPid, flash) {
    const sec = book.sections[id];
    if (!sec) return;
    cur = id;
    hideFloat();
    const html = sec.paras.map(([pid, h, cls]) => `<p data-p="${pid}"${cls ? ` class="${cls}"` : ""}>${h}</p>`).join("");
    const crumb = sec.path.slice(0, -1).join(" · ");
    $("page").innerHTML = (crumb ? `<div class="crumb">${esc(crumb)}</div>` : "") + `<h1>${esc(sec.title)}</h1>` + html;
    $("docTitle").textContent = sec.path[0] === sec.title ? sec.title : `${sec.path[0]} – ${sec.title}`;
    document.title = sec.title + " – Sherlock Reader";
    $("btnPrev").disabled = id === 0;
    $("btnNext").disabled = id === book.sections.length - 1;
    $("btnPrev").textContent = id > 0 ? "‹ " + book.sections[id - 1].title : "";
    $("btnNext").textContent = id < book.sections.length - 1 ? book.sections[id + 1].title + " ›" : "";
    $("pager").hidden = false;
    markBookmarks();
    markVocab();
    if (scrollToPid) {
      const el = $("page").querySelector(`p[data-p="${scrollToPid}"]`);
      if (el) {
        requestAnimationFrame(() => {
          const y = el.getBoundingClientRect().top + window.scrollY - topOffset() - 12;
          window.scrollTo(0, y);
          if (flash) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1800); }
        });
      }
    } else window.scrollTo(0, 0);
    updateStatus();
    try { history.replaceState(null, "", "#s" + id); } catch (e) { /* sandboxed preview: no URL updates */ }
  }

  const topOffset = () => document.querySelector(".topbar").offsetHeight;

  function markBookmarks() {
    $("page").querySelectorAll("p.bm").forEach((p) => p.classList.remove("bm"));
    db.bookmarks.filter((b) => b.s === cur).forEach((b) => {
      const p = $("page").querySelector(`p[data-p="${b.p}"]`);
      if (p) p.classList.add("bm");
    });
  }

  function markVocab() {
    db.vocab.filter((v) => v.s === cur).forEach((v) => {
      const p = $("page").querySelector(`p[data-p="${v.p}"]`);
      if (!p || p.querySelector(`[data-v="${v.id}"]`)) return;
      const text = textOf(p);
      let off = v.off;
      if (off == null || text.substr(off, v.word.length).toLowerCase() !== v.word.toLowerCase()) {
        off = text.toLowerCase().indexOf(v.word.toLowerCase());
        if (off < 0) return;
      }
      const a = posAt(p, off), b = posAt(p, off + v.word.length);
      if (!a || !b) return;
      try {
        const r = document.createRange();
        r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
        const span = document.createElement("span");
        span.className = "vw"; span.dataset.v = v.id; span.title = "In your vocabulary" + (v.note ? ": " + v.note : "");
        r.surroundContents(span);
      } catch (e) { /* crosses formatting – skip underline */ }
    });
  }

  // current reading position = first paragraph visible under the top bar
  function visiblePara() {
    const top = topOffset() + 4;
    const ps = $("page").querySelectorAll("p[data-p]");
    let lo = 0, hi = ps.length - 1, ans = null;
    while (lo <= hi) {   // binary search: first p whose bottom is below the top bar
      const mid = (lo + hi) >> 1;
      if (ps[mid].getBoundingClientRect().bottom > top) { ans = ps[mid]; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  }

  let scrollTimer;
  function onScroll() {
    hideFloatIfTap();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const p = visiblePara();
      if (!p || cur < 0) return;
      const pid = +p.dataset.p;
      db.last = { s: cur, p: pid };
      // reaching the bottom of the page counts as finished
      const ps = $("page").querySelectorAll("p[data-p]");
      const lastPid = +ps[ps.length - 1].dataset.p;
      const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      const reached = atEnd ? lastPid : pid;
      if (!db.furthest[cur] || db.furthest[cur] < reached) db.furthest[cur] = reached;
      save();
      updateStatus();
    }, 250);
  }

  function sectionProgress(id) {
    const sec = book.sections[id], f = db.furthest[id];
    if (!f || !sec.paras.length) return 0;
    const first = sec.paras[0][0], last = sec.paras[sec.paras.length - 1][0];
    return Math.min(1, Math.max(0, (f - first + 1) / (last - first + 1)));
  }

  function updateStatus() {
    if (!book || cur < 0) return;
    const sec = book.sections[cur];
    const p = visiblePara();
    let pct = 0;
    if (p) {
      const first = sec.paras[0][0], last = sec.paras[sec.paras.length - 1][0];
      pct = Math.round(((+p.dataset.p - first) / Math.max(1, last - first)) * 100);
    }
    $("status").innerHTML =
      `<span>Section ${cur + 1} of ${book.sections.length}</span><span>${sec.words.toLocaleString()} words</span>` +
      `<span>${db.vocab.length} saved words</span><span class="prog" title="${pct}% of this chapter"><i style="width:${pct}%"></i></span><span>${pct}%</span>`;
  }

  // ---------- contents ----------
  function buildToc() {
    const groups = [];
    book.sections.forEach((s) => {
      const top = s.path[0];
      let g = groups[groups.length - 1];
      if (!g || g.name !== top) groups.push((g = { name: top, items: [] }));
      g.items.push(s);
    });
    let html = "";
    groups.forEach((g) => {
      const open = g.items.some((s) => s.id === cur);
      html += `<details class="toc-book"${open ? " open" : ""}><summary>${esc(g.name)}</summary>`;
      let part = null;
      g.items.forEach((s) => {
        // novels have Parts (3 levels): show the part as a small header
        const nx = book.sections[s.id + 1];
        const p = s.path.length === 3 ? s.path[1]
          : (nx && nx.path.length === 3 && nx.path[1] === s.title ? s.title : null);
        if (p && p !== part) { html += `<div class="toc-part">${esc(p)}</div>`; }
        part = p;
        const pr = sectionProgress(s.id);
        const d = pr >= 0.97 ? `<span class="d done">✓ read</span>` : pr > 0 ? `<span class="d">${Math.round(pr * 100)}%</span>` : "";
        const label = s.title === g.name || s.title === p ? "Opening" : s.title;
        html += `<a href="#s${s.id}" data-s="${s.id}"${s.id === cur ? ' class="cur"' : ""}><span class="t">${esc(label)}</span>${d}</a>`;
      });
      html += `</details>`;
    });
    $("toc").innerHTML = `<div class="toc">${html}</div>`;
    const cb = $("continueBox");
    if (db.last && book.sections[db.last.s]) {
      cb.innerHTML = `<button class="btn primary block" id="btnContinue">▶ Continue reading<br><small>${esc(pathText(book.sections[db.last.s]))}</small></button>`;
      $("btnContinue").onclick = () => { closePanels(); renderSection(db.last.s, db.last.p, true); };
    } else cb.innerHTML = "";
    const c = $("toc").querySelector("a.cur");
    if (c) setTimeout(() => c.scrollIntoView({ block: "center" }), 30);
  }
  $("toc").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-s]");
    if (!a) return;
    e.preventDefault();
    closePanels();
    renderSection(+a.dataset.s);
  });

  // ---------- panels ----------
  const panels = ["panelContents", "panelBookmarks", "panelVocab"];
  function openPanel(id) {
    panels.forEach((p) => ($(p).hidden = p !== id));
    $("scrim").hidden = false;
    hideFloat();
    if (id === "panelContents") buildToc();
    if (id === "panelBookmarks") buildBookmarks();
    if (id === "panelVocab") buildVocab();
  }
  function closePanels() { panels.forEach((p) => ($(p).hidden = true)); $("scrim").hidden = true; }
  $("scrim").onclick = closePanels;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closePanels));
  $("btnContents").onclick = () => openPanel("panelContents");
  $("btnBookmarks").onclick = () => openPanel("panelBookmarks");
  $("btnVocab").onclick = () => openPanel("panelVocab");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePanels(); hideFloat(); }
    if (e.target.closest("input,textarea") || !$("scrim").hidden) return;
    if (e.key === "ArrowRight" && e.altKey === false && e.ctrlKey) $("btnNext").click();
    if (e.key === "ArrowLeft" && e.ctrlKey) $("btnPrev").click();
  });

  // ---------- bookmarks ----------
  function snippet(p) { const t = textOf(p).replace(/\s+/g, " ").trim(); return t.length > 140 ? t.slice(0, 140) + "…" : t; }
  function addBookmark(p) {
    const pid = +p.dataset.p;
    if (db.bookmarks.some((b) => b.s === cur && b.p === pid)) { toast("Already bookmarked"); return; }
    db.bookmarks.unshift({ id: uid(), s: cur, p: pid, text: snippet(p), path: pathText(book.sections[cur]), at: Date.now() });
    save(); markBookmarks(); toast("🔖 Bookmarked");
  }
  function buildBookmarks() {
    const list = $("bmList");
    let html = "";
    if (db.last && book.sections[db.last.s]) {
      html += `<div class="bm-item"><div class="where">Where you stopped (saved automatically)</div><div class="snip">${esc(pathText(book.sections[db.last.s]))}</div>` +
        `<div class="row"><button class="btn small primary" data-go-last>Continue reading</button></div></div>`;
    }
    if (!db.bookmarks.length) html += `<p class="empty">No bookmarks yet.</p>`;
    db.bookmarks.forEach((b) => {
      html += `<div class="bm-item"><div class="where">${esc(b.path)} · ${fmtDate(b.at)}</div><div class="snip">${esc(b.text)}</div>` +
        `<div class="row"><button class="btn small primary" data-go="${b.id}">Go</button><button class="btn small" data-del="${b.id}">Remove</button></div></div>`;
    });
    list.innerHTML = html;
  }
  $("bmList").addEventListener("click", (e) => {
    const t = e.target;
    if (t.matches("[data-go-last]")) { closePanels(); renderSection(db.last.s, db.last.p, true); }
    const g = t.dataset.go && db.bookmarks.find((b) => b.id === t.dataset.go);
    if (g) { closePanels(); renderSection(g.s, g.p, true); }
    if (t.dataset.del) { db.bookmarks = db.bookmarks.filter((b) => b.id !== t.dataset.del); save(); buildBookmarks(); markBookmarks(); }
  });

  // ---------- selection / tap toolbar ----------
  let pending = null;   // {p, word, start, end} or {p} for tap
  const fl = $("float");
  function hideFloat() { fl.hidden = true; pending = null; document.querySelectorAll("p.sel").forEach((x) => x.classList.remove("sel")); }
  function hideFloatIfTap() { if (pending && !pending.word) hideFloat(); }
  function showFloat(rect, withSave) {
    $("fSave").hidden = !withSave;
    fl.hidden = false;
    const w = fl.offsetWidth, h = fl.offsetHeight;
    let x = rect.left + rect.width / 2 - w / 2 + window.scrollX;
    x = Math.max(8 + window.scrollX, Math.min(x, window.scrollX + document.documentElement.clientWidth - w - 8));
    let y = rect.bottom + window.scrollY + 8;
    if (rect.bottom + h + 40 > window.innerHeight) y = rect.top + window.scrollY - h - 8;
    fl.style.left = x + "px"; fl.style.top = y + "px";
  }

  function checkSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const p = node && node.closest && node.closest("#page p[data-p]");
    if (!p) return false;
    const word = sel.toString().replace(/\s+/g, " ").trim().replace(/^[“”"‘’'(\[,.;:!?—-]+|[“”"‘’')\],.;:!?—-]+$/g, "");
    if (!word || word.length > 120) return false;
    let start = offsetIn(p, r.startContainer, r.startOffset);
    let end = p.contains(r.endContainer) ? offsetIn(p, r.endContainer, r.endOffset) : textOf(p).length;
    const text = textOf(p);
    const k = text.indexOf(word, Math.max(0, start - 2));
    if (k >= 0 && k <= end) { start = k; end = k + word.length; }
    pending = { p, word, start, end };
    showFloat(r.getBoundingClientRect(), true);
    return true;
  }
  let selTimer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) { if (!checkSelection() && pending && pending.word) hideFloat(); }
    }, 200);
  });
  $("page").addEventListener("click", (e) => {
    if (e.target.closest(".vw")) {
      const v = db.vocab.find((x) => x.id === e.target.closest(".vw").dataset.v);
      if (v) { toast(`“${v.word}” is in your vocabulary` + (v.note ? ` – ${v.note}` : "")); return; }
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;   // selection handled above
    const p = e.target.closest("p[data-p]");
    if (!p) { hideFloat(); return; }
    if (pending && pending.p === p && !pending.word) { hideFloat(); return; }
    hideFloat();
    p.classList.add("sel");
    pending = { p };
    showFloat({ left: e.clientX - 1, width: 2, top: e.clientY - 10, bottom: e.clientY + 10 }, false);
  });
  document.addEventListener("mousedown", (e) => { if (!fl.contains(e.target) && !e.target.closest("#page")) hideFloat(); });
  fl.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection on desktop

  $("fMark").onclick = () => { if (pending) addBookmark(pending.p); hideFloat(); window.getSelection().removeAllRanges(); };
  $("fSave").onclick = () => {
    if (!pending || !pending.word) return;
    const { p, word, start, end } = pending;
    const text = textOf(p);
    const sentence = sentenceAround(text, start, end);
    const paragraph = text.replace(/\s+/g, " ").trim();
    const dup = db.vocab.find((v) => v.word.toLowerCase() === word.toLowerCase());
    openSaveDialog({ word, sentence, paragraph, s: cur, p: +p.dataset.p, off: start, path: pathText(book.sections[cur]) }, dup);
    hideFloat();
    window.getSelection().removeAllRanges();
  };

  // ---------- save dialog ----------
  let draft = null;
  function openSaveDialog(d, dup) {
    draft = d;
    $("sWord").value = d.word;
    $("sSentence").value = d.sentence;
    $("sWhole").checked = false;
    $("sNote").value = "";
    $("sSrc").textContent = "From: " + d.path + (dup ? `  ·  Note: you already saved “${dup.word}” before – it will be added again with this new sentence.` : "");
    const dlg = $("dlgSave");
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    setTimeout(() => $("sNote").focus(), 50);
  }
  $("sWhole").onchange = () => { if (draft) $("sSentence").value = $("sWhole").checked ? draft.paragraph : draft.sentence; };
  $("dlgSave").addEventListener("close", () => {
    if ($("dlgSave").returnValue !== "ok" || !draft) { draft = null; return; }
    const word = $("sWord").value.trim();
    if (!word) return;
    db.vocab.unshift({
      id: uid(), word, sentence: $("sSentence").value.trim(), paragraph: draft.paragraph,
      s: draft.s, p: draft.p, off: word === draft.word ? draft.off : null, path: draft.path,
      note: $("sNote").value.trim(), at: Date.now(), exported: false,
    });
    save(); draft = null;
    updateCount(); markVocab(); updateStatus();
    toast(`Saved “${word}” to your vocabulary`);
  });
  $("formSave").addEventListener("submit", (e) => {
    // fallback for browsers without <dialog>
    if (!$("dlgSave").showModal) { e.preventDefault(); $("dlgSave").returnValue = e.submitter ? e.submitter.value : "ok"; $("dlgSave").removeAttribute("open"); $("dlgSave").dispatchEvent(new Event("close")); }
  });

  // ---------- vocabulary panel ----------
  function updateCount() { $("vocabCount").textContent = db.vocab.length; }
  function highlight(sentence, word) {
    const i = sentence.toLowerCase().indexOf(word.toLowerCase());
    if (i < 0) return esc(sentence);
    return esc(sentence.slice(0, i)) + "<b>" + esc(sentence.slice(i, i + word.length)) + "</b>" + esc(sentence.slice(i + word.length));
  }
  function buildVocab() {
    $("lang").value = db.settings.lang || "";
    $("onlyNew").checked = !!db.settings.onlyNew;
    const q = $("vSearch").value.trim().toLowerCase();
    const items = db.vocab.filter((v) => !q || (v.word + " " + v.sentence + " " + v.note).toLowerCase().includes(q));
    if (!db.vocab.length) {
      $("vList").innerHTML = `<p class="empty">No words yet.<br><br>While reading, select a word (double-click on a computer, press and hold on a phone), then tap <b>＋ Save word</b>.</p>`;
      return;
    }
    const newCount = db.vocab.filter((v) => !v.exported).length;
    $("vList").innerHTML = `<p class="hint">${db.vocab.length} words · ${newCount} not exported yet</p>` + items.map((v) =>
      `<div class="v-item" data-id="${v.id}"><div class="w">${esc(v.word)}${v.exported ? '<span class="tag">exported</span>' : ""}</div>` +
      `<blockquote>${highlight(v.sentence, v.word)}</blockquote>` +
      `<div class="where">${esc(v.path)} · ${fmtDate(v.at)}</div>` +
      `<input data-note value="${esc(v.note || "")}" placeholder="Add a note (e.g. the meaning the AI gave you)">` +
      `<div class="row"><button class="btn small" data-go>Show in book</button><button class="btn small" data-del>Delete</button></div></div>`
    ).join("");
  }
  $("vSearch").oninput = buildVocab;
  $("lang").onchange = () => { db.settings.lang = $("lang").value.trim(); save(); };
  $("onlyNew").onchange = () => { db.settings.onlyNew = $("onlyNew").checked; save(); };
  $("vList").addEventListener("click", (e) => {
    const item = e.target.closest(".v-item");
    if (!item) return;
    const v = db.vocab.find((x) => x.id === item.dataset.id);
    if (!v) return;
    if (e.target.matches("[data-go]")) { closePanels(); renderSection(v.s, v.p, true); }
    if (e.target.matches("[data-del]")) {
      if (!confirmDelete(item)) return;
      db.vocab = db.vocab.filter((x) => x.id !== v.id); save(); updateCount(); buildVocab();
      if (v.s === cur) renderSection(cur, visiblePara() && +visiblePara().dataset.p);
    }
  });
  // two-tap delete instead of a blocking confirm() dialog
  function confirmDelete(item) {
    const b = item.querySelector("[data-del]");
    if (b.dataset.armed) return true;
    b.dataset.armed = "1"; b.textContent = "Tap again to delete";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Delete"; } }, 3000);
    return false;
  }
  $("vList").addEventListener("change", (e) => {
    if (!e.target.matches("[data-note]")) return;
    const v = db.vocab.find((x) => x.id === e.target.closest(".v-item").dataset.id);
    if (v) { v.note = e.target.value.trim(); save(); }
  });

  function exportItems() {
    const list = db.settings.onlyNew ? db.vocab.filter((v) => !v.exported) : db.vocab.slice();
    return list.reverse(); // oldest first, in reading order
  }
  function buildMarkdown(list) {
    const lang = (db.settings.lang || "").trim();
    const today = new Date().toISOString().slice(0, 10);
    let md = `# My English vocabulary from Sherlock Holmes (${list.length} ${list.length === 1 ? "word" : "words"})\n\n`;
    md += `_Exported ${today} from Sherlock Reader_\n\n`;
    md += `## Instructions for the AI\n\n`;
    md += `I am learning English by reading *The Complete Sherlock Holmes* by Arthur Conan Doyle (written 1887–1927, Victorian/Edwardian British English). `;
    md += `Below are words and phrases I did not understand, each with the exact sentence where I found it. For **each** item, please give:\n\n`;
    md += `1. **Meaning in this sentence**: what the word means *here*, in simple English (many words have several meanings, so use the context).\n`;
    md += `2. **The whole sentence in plain modern English**, so I understand the context.\n`;
    if (lang) md += `3. **${lang} translation** of the word and of the sentence.\n`;
    const n = lang ? 4 : 3;
    md += `${n}. **Other common meanings** of the word, if any.\n`;
    md += `${n + 1}. **Two simple example sentences** using the word today, and say if the word is old-fashioned or still common.\n`;
    md += `\nIf I wrote a note, it is my own guess; tell me if it is right.\n\n---\n\n`;
    list.forEach((v, i) => {
      md += `### ${i + 1}. ${v.word}\n\n`;
      md += v.sentence.split("\n").map((l) => "> " + l).join("\n") + "\n\n";
      md += `- Source: ${v.path}\n`;
      if (v.note) md += `- My note: ${v.note}\n`;
      md += `\n`;
    });
    return md;
  }
  function markExported(list) { list.forEach((v) => (v.exported = true)); save(); buildVocab(); }
  $("btnExport").onclick = () => {
    const list = exportItems();
    if (!list.length) { toast(db.vocab.length ? "No new words since your last export" : "Save some words first"); return; }
    download(`sherlock-vocabulary-${new Date().toISOString().slice(0, 10)}.md`, buildMarkdown(list), "text/markdown");
    markExported(list);
    toast(`Exported ${list.length} words – now upload or paste the file into your AI`);
  };
  $("btnCopy").onclick = async () => {
    const list = exportItems();
    if (!list.length) { toast(db.vocab.length ? "No new words since your last export" : "Save some words first"); return; }
    const md = buildMarkdown(list);
    try { await navigator.clipboard.writeText(md); }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    markExported(list);
    toast(`Copied ${list.length} words – paste into your AI chat`);
  };
  function download(name, content, type) {
    const blob = new Blob([content], { type: type + ";charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $("btnBackup").onclick = () => download(`sherlock-reader-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db, null, 1), "application/json");
  $("fileImport").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.vocab)) throw new Error("not a backup");
      // merge: keep everything, skip items already present
      const have = new Set(db.vocab.map((v) => v.id));
      data.vocab.forEach((v) => { if (!have.has(v.id)) db.vocab.push(v); });
      db.vocab.sort((a, b) => b.at - a.at);
      const hb = new Set(db.bookmarks.map((b) => b.id));
      (data.bookmarks || []).forEach((b) => { if (!hb.has(b.id)) db.bookmarks.push(b); });
      Object.entries(data.furthest || {}).forEach(([k, v]) => { if (!db.furthest[k] || db.furthest[k] < v) db.furthest[k] = v; });
      if (data.last && !db.last) db.last = data.last;
      save(); updateCount(); buildVocab(); renderSection(cur);
      toast("Backup restored");
    } catch (err) { toast("That file is not a Sherlock Reader backup"); }
    e.target.value = "";
  };

  // ---------- appearance ----------
  function applySettings() {
    const s = db.settings;
    document.documentElement.style.setProperty("--font-size", s.fontSize + "px");
    document.body.classList.toggle("sepia", s.theme === "sepia");
    document.body.classList.toggle("dark", s.theme === "dark");
    document.body.classList.toggle("sans", s.font === "sans");
    document.querySelector('meta[name="theme-color"]').content = s.theme === "dark" ? "#1c1c1c" : "#2b579a";
  }
  function changeFont(d) {
    const p = visiblePara(), pid = p && +p.dataset.p;
    db.settings.fontSize = Math.max(14, Math.min(30, db.settings.fontSize + d));
    applySettings(); save();
    if (pid) renderSection(cur, pid);
  }
  $("btnFontUp").onclick = () => changeFont(1);
  $("btnFontDown").onclick = () => changeFont(-1);
  $("btnTheme").onclick = () => {
    const order = ["light", "sepia", "dark"];
    db.settings.theme = order[(order.indexOf(db.settings.theme) + 1) % 3];
    applySettings(); save();
    toast({ light: "White page", sepia: "Sepia page", dark: "Dark page" }[db.settings.theme]);
  };

  $("btnPrev").onclick = () => cur > 0 && renderSection(cur - 1);
  $("btnNext").onclick = () => cur < book.sections.length - 1 && renderSection(cur + 1);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("hashchange", () => {
    const m = location.hash.match(/^#s(\d+)$/);
    if (m && +m[1] !== cur) renderSection(+m[1]);
  });

  // ---------- start ----------
  applySettings();
  updateCount();
  let storageOk = true;
  try { localStorage.setItem(KEY + "-test", "1"); localStorage.removeItem(KEY + "-test"); } catch (e) { storageOk = false; }
  loadBook().then((b) => {
    book = b;
    let m = null;
    try { m = location.hash.match(/^#s(\d+)$/); } catch (e) {}
    if (m && book.sections[+m[1]] && (!db.last || db.last.s !== +m[1])) renderSection(+m[1]);
    else if (db.last && book.sections[db.last.s]) { renderSection(db.last.s, db.last.p, true); toast("Welcome back – continuing where you stopped"); }
    else renderSection(0);
    if (!storageOk) setTimeout(() => toast("This preview can\u2019t save bookmarks or words. Download the file and open it in your browser to save."), 600);
  }).catch((e) => {
    $("page").innerHTML = `<p class="loading">Could not open the book (${esc(e.message)}). Please reload the page.</p>`;
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
