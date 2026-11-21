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
      db.last = { s: cur, p: pid }; db.lastAt = Date.now();
      db.readLog = db.readLog || {}; db.readLog[today()] = (db.readLog[today()] || 0) + 1;
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
  const panels = ["panelContents", "panelBookmarks", "panelVocab", "panelProgress"];
  function openPanel(id) {
    panels.forEach((p) => ($(p).hidden = p !== id));
    $("scrim").hidden = false;
    hideFloat();
    if (id === "panelContents") buildToc();
    if (id === "panelBookmarks") buildBookmarks();
    if (id === "panelVocab") buildVocab();
    if (id === "panelProgress") buildProgress();
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
    $("fSave").hidden = !withSave; $("fAsk").hidden = !withSave; $("fTrans").hidden = !withSave;
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

  // ---------- translate selected text (AI in context, dictionary fallback) ----------
  let tr = null;   // {word, start, sentence, paragraph, s, p, path, info}
  function selContext() {
    const { p, word, start, end } = pending;
    const text = textOf(p);
    return { word, start, sentence: sentenceAround(text, start, end), paragraph: text.replace(/\s+/g, " ").trim(), s: cur, p: +p.dataset.p, path: pathText(book.sections[cur]) };
  }
  const markIn = (sentence, word) => esc(sentence).replace(esc(word), `<mark>${esc(word)}</mark>`);
  $("fTrans").onclick = async () => {
    if (!pending || !pending.word) return;
    const me = selContext();
    hideFloat(); window.getSelection().removeAllRanges();
    lookupTr(me);
  };
  async function lookupTr(me) {
    tr = me;
    $("trQuote").innerHTML = markIn(me.sentence, me.word) + `<cite>${esc(me.path)}</cite>`;
    $("trBody").innerHTML = `<p class="hint">${aiReady() ? "✨ AI is reading the sentence…" : "Looking it up…"}</p>`;
    if (!$("dlgTr").open) $("dlgTr").showModal();
    const info = { word: me.word };
    if (aiReady()) {
      info.aiTried = true;
      try {
        const r = await askAI(`You help an English learner whose first language is ${langName()}. They are reading Sherlock Holmes (Victorian English).
Selected text: "${me.word}"
Sentence: "${me.sentence}"
Reply with JSON only: {"translation": "${langName()} translation of the selected text as used in this sentence", "meaning": "what it means IN THIS SENTENCE, very simple English, max 20 words", "pos": "part of speech (or 'phrase')", "ipa": "IPA pronunciation if it is one word, else empty", "sentence_translation": "natural ${langName()} translation of the whole sentence", "other": "other common meanings, short, or empty", "tip": "one short tip in simple English (e.g. old-fashioned word, common collocation), or empty"}`, true);
        Object.assign(info, { vi: r.translation, meaning: r.meaning, pos: r.pos, ipa: r.ipa, sentenceVi: r.sentence_translation, other: r.other, tip: r.tip, meaningSrc: "ai" });
      } catch (e) { info.err = "AI helper: " + e.message + " – showing the dictionary instead."; }
    }
    if (!info.meaning) {
      const [d, vi, sv] = await Promise.all([me.word.split(" ").length <= 3 ? dictLookup(me.word) : null, translate(me.word), translate(me.sentence)]);
      if (d) Object.assign(info, { defs: d.defs, ipa: d.ipa, meaning: d.defs[0].def, pos: d.defs[0].pos, meaningSrc: "dict" });
      info.vi = vi; info.sentenceVi = sv;
    }
    if (tr !== me) return;   // another lookup started
    me.info = info;
    renderTr();
  }
  function renderTr() {
    const i = tr.info; let h = "";
    if (i.err) h += `<p class="hint">${esc(i.err)}</p>`;
    h += `<div class="tr-word">${i.pos ? `<span class="pos">${esc(posShort(i.pos))}</span> ` : ""}<b>${esc(i.word)}</b> ${say(i.word)} ${i.ipa ? `<span class="ipa">${esc(i.ipa)}</span>` : ""}</div>`;
    if (i.meaning) h += `<div class="tr-mean">${esc(i.meaning)} <span class="tag">${i.meaningSrc === "ai" ? "AI · in this sentence" : "dictionary"}</span></div>`;
    else if (!i.vi) h += `<p class="hint">No meaning found. ${aiReady() ? "" : `<button class="link" data-ai-setup>✨ Set up AI helper</button> for meanings in context.`}</p>`;
    if (i.meaningSrc === "dict" && i.defs && i.defs.length > 1)
      h += `<details class="others"><summary>Other dictionary meanings</summary>` + i.defs.slice(1).map((d) => `<div class="def"><i>${esc(posShort(d.pos))}</i> ${esc(d.def)}</div>`).join("") + `</details>`;
    if (i.other) h += `<div class="tr-other"><b>Other meanings:</b> ${esc(i.other)}</div>`;
    if (i.tip) h += `<div class="tr-other">💡 ${esc(i.tip)}</div>`;
    h += viBlock((i.vi ? `<div class="tr-vi">🇻🇳 ${esc(i.vi)}</div>` : "") + (i.sentenceVi ? `<div class="tr-sent"><b>Whole sentence:</b> ${esc(i.sentenceVi)}</div>` : ""));
    if (!aiReady() && i.meaning) h += `<p class="hint">Dictionary meanings may not fit this sentence. <button class="link" data-ai-setup>✨ Set up AI helper</button> for a meaning in context.</p>`;
    $("trBody").innerHTML = h;
  }
  $("dlgTr").addEventListener("click", (e) => {
    const t = e.target;
    if (t === $("dlgTr") || t.matches("[data-close-tr]")) $("dlgTr").close();
    else if (t.dataset.say) sayText(t.dataset.say);
    else if (t.matches("[data-ai-setup]")) openAISetup();
  });
  $("trSave").onclick = () => {
    if (!tr) return;
    const dup = db.vocab.find((v) => v.word.toLowerCase() === tr.word.toLowerCase());
    $("dlgTr").close();
    openSaveDialog({ word: tr.word, sentence: tr.sentence, paragraph: tr.paragraph, s: tr.s, p: tr.p, off: tr.start, path: tr.path, info: tr.info }, dup);
  };
  $("trAsk").onclick = () => { if (!tr) return; $("dlgTr").close(); openAsk(tr); };

  // ---------- ask AI about selected text ----------
  let ask = null;   // {word, sentence, paragraph, path, msgs, ctx}
  $("fAsk").onclick = () => {
    if (!pending || !pending.word) return;
    const c = selContext();
    hideFloat(); window.getSelection().removeAllRanges();
    openAsk(c);
  };
  function openAsk(c) {
    ask = Object.assign({}, c, { msgs: [] });
    const word = ask.word;
    $("askQuote").innerHTML = esc(ask.sentence).replace(esc(word), `<mark>${esc(word)}</mark>`) + `<cite>${esc(ask.path)}</cite>`;
    $("askLog").innerHTML = aiReady() ? "" : `<p class="hint">To ask questions, add your AI key first (DeepSeek, Gemini, Claude or OpenAI). <button class="link" data-ai-setup>✨ Set up AI helper</button></p>`;
    $("askInput").value = "";
    $("askQuick").hidden = false;
    $("dlgAsk").showModal();
    if (aiReady()) setTimeout(() => $("askInput").focus(), 50);
  }
  function askSend(q) {
    q = (q || "").trim();
    if (!q || !ask) return;
    if (!aiReady()) { openAISetup(); return; }
    if (!ask.msgs.length) {
      q = `I am reading Sherlock Holmes to learn English (my first language: ${langName()}). Selected text: "${ask.word}"
Sentence: "${ask.sentence}"
Paragraph: "${ask.paragraph.slice(0, 1500)}"
(${ask.path})

My question: ${q}

Answer clearly and briefly for a learner (under 150 words unless I ask for more). Answer in simple English${showVi() ? `; add a short ${langName()} translation at the end` : " (only use another language if I ask in it)"}.`;
    }
    const shown = ask.msgs.length ? q : q.split("My question: ")[1].split("\n\nAnswer clearly")[0];
    ask.msgs.push({ role: "user", content: q });
    const log = $("askLog");
    log.insertAdjacentHTML("beforeend", `<div class="msg me">${esc(shown)}</div><div class="msg ai busy">✨ Thinking…</div>`);
    const bubble = log.lastElementChild;
    bubble.scrollIntoView({ block: "nearest" });
    $("askQuick").hidden = true; $("askInput").value = ""; $("askSend").disabled = true;
    const mine = ask;
    askAIMsgs(ask.msgs).then((t) => {
      mine.msgs.push({ role: "assistant", content: t });
      bubble.classList.remove("busy"); bubble.innerHTML = fmtAI(t);
    }).catch((e) => {
      mine.msgs.pop();
      bubble.classList.remove("busy"); bubble.classList.add("err"); bubble.textContent = "AI helper error: " + e.message;
    }).finally(() => { $("askSend").disabled = false; bubble.scrollIntoView({ block: "nearest" }); });
  }
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); askSend($("askInput").value); });
  $("askInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askSend($("askInput").value); } });
  $("dlgAsk").addEventListener("click", (e) => {
    const t = e.target;
    if (t === $("dlgAsk") || t.matches("[data-close-ask]")) $("dlgAsk").close();
    else if (t.matches("[data-q]")) askSend(t.dataset.q);
    else if (t.matches("[data-ai-setup]")) openAISetup();
  });
  $("askSaveWord").onclick = () => {
    if (!ask) return;
    const dup = db.vocab.find((v) => v.word.toLowerCase() === ask.word.toLowerCase());
    $("dlgAsk").close();
    openSaveDialog({ word: ask.word, sentence: ask.sentence, paragraph: ask.paragraph, s: ask.s, p: ask.p, off: ask.start, path: ask.path }, dup);
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
    const info = draft.info;
    if (info && word === draft.word) {
      const v = db.vocab[0];
      ["meaning", "pos", "vi", "ipa", "defs", "meaningSrc", "tip", "aiTried"].forEach((k) => { if (info[k]) v[k] = info[k]; });
    }
    save(); draft = null;
    updateCount(); markVocab(); updateStatus();
    enrich(db.vocab[0]);   // fetch the meaning in the background
    toast(`Saved “${word}” to your vocabulary`);
  });
  $("formSave").addEventListener("submit", (e) => {
    // fallback for browsers without <dialog>
    if (!$("dlgSave").showModal) { e.preventDefault(); $("dlgSave").returnValue = e.submitter ? e.submitter.value : "ok"; $("dlgSave").removeAttribute("open"); $("dlgSave").dispatchEvent(new Event("close")); }
  });

  // ---------- vocabulary panel ----------
  function updateCount() { $("vocabCount").textContent = db.vocab.length; if (typeof updateReviewBadge === "function" && $("reviewCount")) updateReviewBadge(); }
  function highlight(sentence, word) {
    const i = sentence.toLowerCase().indexOf(word.toLowerCase());
    if (i < 0) return esc(sentence);
    return esc(sentence.slice(0, i)) + "<b>" + esc(sentence.slice(i, i + word.length)) + "</b>" + esc(sentence.slice(i + word.length));
  }
  function buildVocab() {
    $("lang").value = db.settings.lang || "";
    $("optVi").checked = showVi();
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
  $("optVi").onchange = () => { db.settings.showVi = $("optVi").checked; save(); };
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
  // ---------- my progress: stats, export, import ----------
  const stamp = () => new Date().toISOString().slice(0, 10);
  function bookStats() {
    const groups = [];
    book.sections.forEach((s) => {
      if (s.path[0] === "About this book") return;
      let g = groups[groups.length - 1];
      if (!g || g.name !== s.path[0]) groups.push((g = { name: s.path[0], secs: [], words: 0, read: 0, done: 0 }));
      const pr = sectionProgress(s.id);
      g.secs.push(s); g.words += s.words; g.read += s.words * pr; if (pr >= 0.97) g.done++;
    });
    return groups;
  }
  function vocabStats() {
    const st = { total: db.vocab.length, fresh: 0, learning: 0, mastered: 0, due: 0, hard: [] };
    db.vocab.forEach((v) => {
      const s = srsOf(v);
      if (s.due <= Date.now()) st.due++;
      if (s.reps === 0 && !s.lapses) st.fresh++; else if (s.ivl >= 21) st.mastered++; else st.learning++;
    });
    st.hard = db.vocab.filter((v) => (v.srs && v.srs.lapses) > 0).sort((a, b) => b.srs.lapses - a.srs.lapses).slice(0, 10);
    return st;
  }
  function studyDays() { return new Set([...Object.keys(db.reviewLog || {}), ...Object.keys(db.readLog || {})]).size; }
  function buildProgress() {
    const groups = bookStats(), vs = vocabStats();
    const words = groups.reduce((a, g) => a + g.words, 0), read = groups.reduce((a, g) => a + g.read, 0);
    const chapters = groups.reduce((a, g) => a + g.secs.length, 0), done = groups.reduce((a, g) => a + g.done, 0);
    const reviews = Object.values(db.reviewLog || {}).reduce((a, b) => a + b, 0);
    const pct = (x) => Math.round(x * 100);
    let html = `<div class="stats">
      <div class="stat"><b>${pct(read / words)}%</b><span>of the whole book</span></div>
      <div class="stat"><b>${Math.round(read).toLocaleString()}</b><span>words read</span></div>
      <div class="stat"><b>${done}/${chapters}</b><span>chapters finished</span></div>
      <div class="stat"><b>🔥 ${streak()}</b><span>day streak · ${studyDays()} days studied</span></div>
      <div class="stat"><b>${vs.total}</b><span>saved words</span></div>
      <div class="stat"><b>${vs.mastered}</b><span>words remembered well (21+ days)</span></div>
    </div>`;
    html += `<p class="hint">Words: ${vs.fresh} new · ${vs.learning} learning · ${vs.mastered} remembered · ${vs.due} due now · ${reviews} reviews done</p>`;
    if (db.last && book.sections[db.last.s]) html += `<button class="btn primary block" data-go-last>▶ Continue: ${esc(pathText(book.sections[db.last.s]))}</button>`;
    html += `<h3 class="ph">Books</h3>`;
    groups.forEach((g) => {
      const next = g.secs.find((s) => s.words > 60 && sectionProgress(s.id) < 0.97);
      html += `<div class="bookrow"><div class="bt"><span>${esc(g.name)}</span><span class="d">${g.done}/${g.secs.length} chapters</span></div>
        <div class="bar"><i style="width:${pct(g.read / Math.max(1, g.words))}%"></i></div>
        ${next && g.read > 0 ? `<button class="link" data-go-sec="${next.id}">Next: ${esc(next.title)}</button>` : ""}</div>`;
    });
    if (vs.hard.length) html += `<h3 class="ph">Words you forget most</h3><p>${vs.hard.map((v) => `<span class="chip">${esc(v.word)}</span>`).join(" ")}</p>`;
    $("progBody").innerHTML = html;
  }
  $("progBody").addEventListener("click", (e) => {
    if (e.target.matches("[data-go-last]")) { closePanels(); renderSection(db.last.s, db.last.p, true); }
    if (e.target.dataset.goSec) { closePanels(); renderSection(+e.target.dataset.goSec); }
  });
  document.querySelectorAll("[data-open-progress]").forEach((b) => (b.onclick = () => openPanel("panelProgress")));
  $("btnProgress").onclick = () => openPanel("panelProgress");

  $("btnExportAll").onclick = () => {
    const out = Object.assign({ app: "Sherlock Reader", kind: "learning-progress", version: 1, exportedAt: new Date().toISOString() }, db);
    out.settings = Object.assign({}, db.settings, { ai: undefined });   // your AI key stays on this device
    download(`sherlock-learning-${stamp()}.json`, JSON.stringify(out, null, 1), "application/json");
    toast("Saved – keep this file to continue later or on another device");
  };
  $("btnReport").onclick = () => {
    const groups = bookStats(), vs = vocabStats();
    const words = groups.reduce((a, g) => a + g.words, 0), read = groups.reduce((a, g) => a + g.read, 0);
    let md = `# My English learning with Sherlock Holmes – ${stamp()}\n\n`;
    md += `- Read: **${Math.round((read / words) * 100)}%** of the complete book (${Math.round(read).toLocaleString()} words)\n`;
    md += `- Study streak: **${streak()} days** (${studyDays()} days studied in total)\n`;
    md += `- Vocabulary: ${vs.total} saved · ${vs.mastered} remembered well · ${vs.learning} learning · ${vs.fresh} new\n`;
    if (db.last && book.sections[db.last.s]) md += `- Currently reading: ${pathText(book.sections[db.last.s])}\n`;
    md += `\n## Books\n\n| Book | Progress | Chapters finished |\n| --- | --- | --- |\n`;
    groups.forEach((g) => (md += `| ${g.name} | ${Math.round((g.read / Math.max(1, g.words)) * 100)}% | ${g.done}/${g.secs.length} |\n`));
    if (vs.hard.length) md += `\n## Words I forget most\n\n` + vs.hard.map((v) => `- **${v.word}** (forgot ${v.srs.lapses}×) – “${v.sentence}”${v.note ? ` – my note: ${v.note}` : ""}`).join("\n") + "\n";
    const recent = db.vocab.slice(0, 20);
    if (recent.length) md += `\n## Latest words\n\n` + recent.map((v) => `- **${v.word}**${v.note ? `: ${v.note}` : ""}`).join("\n") + "\n";
    md += `\n---\n_You can give this report to an AI and ask: “Based on my progress, what should I focus on next? Make me a short study plan and a quiz on the words I forget most.”_\n`;
    download(`sherlock-progress-report-${stamp()}.md`, md, "text/markdown");
  };

  // Import merges: nothing already here is deleted.
  function mergeData(data) {
    const byId = new Map(db.vocab.map((v) => [v.id, v]));
    let added = 0;
    data.vocab.forEach((v) => {
      const mine = byId.get(v.id);
      if (!mine) { db.vocab.push(v); added++; return; }
      if (!mine.note && v.note) mine.note = v.note;
      ["meaning", "vi", "pos", "example", "tip", "defs", "ipa", "meaningSrc"].forEach((k) => { if (!mine[k] && v[k]) mine[k] = v[k]; });
      if (v.learned) mine.learned = true;
      const a = mine.srs, b = v.srs;          // keep the review schedule that is further along
      if (b && (!a || (b.reps + b.lapses) > (a.reps + a.lapses) || ((b.reps + b.lapses) === (a.reps + a.lapses) && b.due > a.due))) mine.srs = b;
      if (v.exported) mine.exported = true;
    });
    db.vocab.sort((a, b) => b.at - a.at);
    const hb = new Set(db.bookmarks.map((b) => b.id));
    (data.bookmarks || []).forEach((b) => { if (!hb.has(b.id)) db.bookmarks.push(b); });
    Object.entries(data.furthest || {}).forEach(([k, v]) => { if (!db.furthest[k] || db.furthest[k] < v) db.furthest[k] = v; });
    if (data.last && (!db.last || (data.lastAt || 0) > (db.lastAt || 0))) { db.last = data.last; db.lastAt = data.lastAt || Date.now(); }
    ["reviewLog", "readLog"].forEach((k) => {
      db[k] = db[k] || {};
      Object.entries(data[k] || {}).forEach(([d, n]) => { db[k][d] = Math.max(db[k][d] || 0, n); });
    });
    return added;
  }
  $("fileImport").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.vocab)) throw new Error("not a backup");
      const added = mergeData(data);
      save(); updateCount();
      if (!$("panelProgress").hidden) buildProgress();
      if (db.last && book.sections[db.last.s]) renderSection(db.last.s, db.last.p, true); else renderSection(cur);
      toast(`Imported – ${added} new ${added === 1 ? "word" : "words"} added. Continuing where you stopped.`);
    } catch (err) { toast("That file is not a Sherlock Reader progress file"); }
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
  $("btnDisplay").onclick = (e) => { e.stopPropagation(); $("displayPop").hidden = !$("displayPop").hidden; };
  document.addEventListener("click", (e) => { if (!e.target.closest("#displayPop,#btnDisplay")) $("displayPop").hidden = true; });
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

  // ---------- read aloud (each character gets a voice) ----------
  const synth = window.speechSynthesis;
  const tts = { on: false, paused: false, s: -1, pi: 0, ci: 0, chunks: [], gen: 0, recent: [] };
  db.settings.voices = db.settings.voices || {};   // role -> {uri, pitch}
  db.settings.rate = db.settings.rate || 1;
  const ROLES = [
    ["narrator", "Narrator (story text)"],
    ["holmes", "Sherlock Holmes"],
    ["watson", "Dr. Watson"],
    ["woman", "Women"],
    ["man", "Other men"],
  ];
  const SAY = "said|says|cried|asked|remarked|answered|replied|continued|observed|whispered|shouted|exclaimed|murmured|returned|added|went on|interrupted|muttered|repeated|groaned|explained|began|suggested|inquired|enquired|roared|sobbed|gasped|snarled|thundered";
  const TITLE = "(?:Mr\\.|Mrs\\.|Miss|Dr\\.|Lady|Lord|Sir|Inspector|Colonel|Captain|Major|Professor|Mister|Madame|Count|Baron|Sergeant|Constable)";
  const NAME = `(?:my (?:friend|companion)|our (?:visitor|client)|the (?:old |young )?(?:man|woman|lady|girl|stranger|inspector|detective)|${TITLE}\\s+[A-Z][\\w'-]+(?:\\s[A-Z][\\w'-]+)?|Sherlock Holmes|[A-Z][\\w'-]+(?:\\s[A-Z][\\w'-]+)?|I|he|she)`;
  const RE_AFTER = new RegExp(`\\b(?:${SAY})\\s+(${NAME})`);       // said Holmes / said I
  const RE_BEFORE = new RegExp(`(?:^|[\\s,.;—])(${NAME})\\s+(?:${SAY})\\b`); // Holmes said / I asked
  const FEMALE = /^(?:Mrs\.|Miss|Lady|Madame)|^(?:she|the (?:old |young )?(?:woman|lady|girl))$/;
  const NOT_NAMES = /^(?:The|It|This|That|There|Then|But|And|What|When|Well|Yes|No|Oh|Ah|Now|So|Why|How|Here|Very|Good|Come)$/;

  function whoFrom(narr) {
    const m = narr.match(RE_AFTER) || narr.match(RE_BEFORE);
    if (!m) return null;
    let n = m[1].trim();
    if (NOT_NAMES.test(n)) return null;
    if (n === "I") return { key: "watson", label: "Watson" };
    if (/^my (?:friend|companion)$/.test(n)) return { key: "companion" };
    if (/Holmes$/.test(n) && !/Mycroft/.test(n)) return { key: "holmes", label: "Holmes" };
    if (/Watson$/.test(n)) return { key: "watson", label: "Watson" };
    if (n === "he") return { key: "?m", label: "" };
    if (n === "she") return { key: "?f", label: "", female: true };
    const female = FEMALE.test(n);
    const label = n.replace(/^(?:the|our|my)\s+/, "");
    return { key: "x:" + label.replace(TITLE_RE, "").trim().toLowerCase(), label: label.charAt(0).toUpperCase() + label.slice(1), female };
  }
  const TITLE_RE = new RegExp("^" + TITLE + "\\s+");

  // split [a,b) of text into sentence-sized chunks (short enough for every browser)
  function chunkRanges(text, a, b) {
    const out = [];
    let s = a;
    for (let i = a; i < b; i++) {
      const c = text[i];
      let cut = -1;
      if (/[.!?]/.test(c)) {
        let j = i + 1;
        while (j < b && /["”’')\]]/.test(text[j])) j++;
        if ((j >= b || /\s/.test(text[j])) && !(c === "." && ABBR.test(text.slice(Math.max(0, i - 8), i + 1)))) cut = j;
      } else if (c === "\n") cut = i + 1;
      else if (i - s > 220 && /[,;:—]/.test(c)) cut = i + 1;
      if (cut > s) { out.push([s, cut]); s = cut; i = cut - 1; }
    }
    if (s < b) out.push([s, b]);
    return out.filter(([x, y]) => /[\w]/.test(text.slice(x, y)));
  }

  // An unnamed "he" talking with Watson is usually Holmes, if Holmes was mentioned just before.
  function holmesNearby(p) {
    let q = p.previousElementSibling;
    for (let k = 0; q && q.matches("p[data-p]") && k < 15; k++, q = q.previousElementSibling) if (/Holmes/.test(q.textContent)) return true;
    return /Holmes/.test(p.textContent);
  }

  // Break a paragraph into narration / speech chunks and guess the speaker.
  function plan(p) {
    const text = textOf(p);
    const parts = [];  // {a,b,speech}
    let i = 0;
    const re = /“[^”]*(?:”|$)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > i) parts.push({ a: i, b: m.index, speech: false });
      parts.push({ a: m.index, b: m.index + m[0].length, speech: true });
      i = m.index + m[0].length;
      if (!m[0].length) break;
    }
    if (i < text.length) parts.push({ a: i, b: text.length, speech: false });
    const narr = parts.filter((x) => !x.speech).map((x) => text.slice(x.a, x.b)).join(" … ");
    const hasSpeech = parts.some((x) => x.speech);
    let who = null;
    if (hasSpeech) {
      who = whoFrom(narr);
      const r = tts.recent;
      if (who && who.key === "companion") {
        // "said my companion" is usually Holmes, unless someone else is the one talking with Watson
        const other = r.slice().reverse().find((x) => x.key !== "watson");
        who = !other || r.some((x) => x.key === "holmes") ? { key: "holmes", label: "Holmes" } : other;
      }
      if (!who || who.key[0] === "?") {
        // unnamed: in a two-person dialogue the speaker alternates
        const guess = r.length >= 2 ? r[r.length - 2] : null;
        if (guess && (!who || !!guess.female === !!who.female)) who = guess;
        else if (who && !who.female && holmesNearby(p)) who = { key: "holmes", label: "Holmes" };
        else if (who) who = { key: who.female ? "x:woman" : "x:man", label: "", female: who.female };
        else who = { key: "x:someone", label: "" };
      }
      r.push(who); if (r.length > 4) r.shift();
    } else if (text.trim()) tts.recent = tts.recent.slice(-2);
    const chunks = [];
    parts.forEach((pt) => chunkRanges(text, pt.a, pt.b).forEach(([a, b]) =>
      chunks.push({ a, b, text: text.slice(a, b).replace(/[“”\n]/g, " "), who: pt.speech ? who : null })));
    return chunks;
  }

  // ----- voices -----
  let allVoices = [];
  const NICE = /natural|neural|premium|enhanced|online/i;
  const FEM_V = /female|zira|samantha|karen|serena|kate|fiona|moira|tessa|victoria|susan|hazel|libby|sonia|jenny|aria|emma|ava|allison|martha|catherine|natasha|clara|michelle|amy|joanna|salli|kimberly|ivy|olivia|maisie|stephanie/i;
  const MALE_V = /male|daniel|arthur|george|ryan|thomas|oliver|alex|fred|david|mark|guy|christopher|eric|brian|james|william|liam|aaron|rishi|matthew|joey|justin|reed|tom|gordon/i;
  function loadVoices() {
    allVoices = synth ? synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang)) : [];
    allVoices.sort((x, y) => (NICE.test(y.name) - NICE.test(x.name)) || (/GB/i.test(y.lang) - /GB/i.test(x.lang)));
  }
  const isFem = (v) => FEM_V.test(v.name) && !/\bmale\b/i.test(v.name.replace(/female/i, ""));
  function defaultVoice(role, n) {
    const men = allVoices.filter((v) => !isFem(v)), women = allVoices.filter(isFem);
    const gb = (list) => list.filter((v) => /GB/i.test(v.lang));
    const pick = (list, k) => list.length ? list[k % list.length] : allVoices[k % Math.max(1, allVoices.length)];
    if (role === "narrator") return pick(gb(men).length ? gb(men) : men, 0);
    if (role === "holmes") return pick(gb(men).length > 1 ? gb(men) : men, 1);
    if (role === "watson") return pick(men, 2);
    if (role === "woman") return pick(gb(women).length ? gb(women) : women, n || 0);
    return pick(men, 3 + (n || 0));
  }
  const DEF_PITCH = { narrator: 1, holmes: 0.9, watson: 1.05, woman: 1.15, man: 0.85 };
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
  function voiceFor(who) {
    let role = "narrator", n = 0;
    if (who) {
      if (who.key === "holmes" || who.key === "watson") role = who.key;
      else { role = who.female ? "woman" : "man"; n = hash(who.key) % 4; }
    }
    const conf = db.settings.voices[role] || {};
    const v = (conf.uri && allVoices.find((x) => x.voiceURI === conf.uri)) || defaultVoice(role, n);
    let pitch = conf.pitch || DEF_PITCH[role];
    // other characters share a voice, so vary the pitch to tell them apart
    if (role === "man" || role === "woman") pitch = Math.max(0.5, Math.min(1.6, pitch + [0, 0.15, -0.12, 0.25][n]));
    return { v, pitch };
  }

  // ----- playback -----
  const hl = window.CSS && CSS.highlights && window.Highlight ? new Highlight() : null;
  if (hl) CSS.highlights.set("tts", hl);
  const hlWord = hl ? new Highlight() : null;
  if (hlWord) CSS.highlights.set("word", hlWord);
  function markWord(p, a, b) {
    if (!hlWord) return;
    hlWord.clear();
    const x = posAt(p, a), y = posAt(p, b);
    if (x && y) { const r = new Range(); r.setStart(x[0], x[1]); r.setEnd(y[0], y[1]); hlWord.add(r); }
  }
  function paraEls() { return $("page").querySelectorAll("p[data-p]"); }
  function showChunk(p, ch) {
    document.querySelectorAll("p.reading").forEach((x) => x !== p && x.classList.remove("reading"));
    p.classList.add("reading");
    if (hl) {
      hl.clear();
      const a = posAt(p, ch.a), b = posAt(p, ch.b);
      if (a && b) { const r = new Range(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); hl.add(r); }
    }
    const rc = p.getBoundingClientRect();
    if (rc.top < topOffset() + 10 || rc.top > window.innerHeight * 0.6) {
      window.scrollTo({ top: rc.top + window.scrollY - topOffset() - 60, behavior: "smooth" });
    }
    $("plWho").textContent = ch.who ? (ch.who.label || (ch.who.female ? "A woman" : "Someone")) : "Narrator";
    $("plWho").className = "who " + (ch.who ? (ch.who.key === "holmes" || ch.who.key === "watson" ? ch.who.key : "other") : "narr");
  }
  function clearShow() { if (hl) hl.clear(); if (hlWord) hlWord.clear(); document.querySelectorAll("p.reading").forEach((x) => x.classList.remove("reading")); }

  function speakNext() {
    if (!tts.on || tts.paused) return;
    if (cur !== tts.s) { stopReading(); return; }   // reader moved to another chapter
    const ps = paraEls();
    while (true) {
      if (tts.pi >= ps.length) {
        if (tts.s >= book.sections.length - 1) { stopReading(); return; }
        tts.s++; tts.pi = 0; tts.ci = 0; tts.chunks = null; tts.recent = [];
        renderSection(tts.s); toast("Next: " + book.sections[tts.s].title);
        return setTimeout(speakNext, 600);
      }
      if (!tts.chunks) { tts.chunks = plan(ps[tts.pi]); tts.ci = 0; }
      if (tts.ci < tts.chunks.length) break;
      tts.pi++; tts.chunks = null;
    }
    const p = ps[tts.pi], ch = tts.chunks[tts.ci];
    showChunk(p, ch);
    if (hlWord) hlWord.clear();
    db.last = { s: tts.s, p: +p.dataset.p }; save();
    const { v, pitch } = voiceFor(ch.who);
    const u = new SpeechSynthesisUtterance(ch.text);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-GB";
    u.pitch = pitch; u.rate = db.settings.rate;
    u.onboundary = (e) => {   // yellow highlight on the word being spoken
      if (e.name && e.name !== "word") return;
      const a = ch.a + e.charIndex;
      const m = textOf(p).slice(a).match(/^[\w'’-]+/);
      markWord(p, a, a + (e.charLength || (m ? m[0].length : 1)));
    };
    const g = ++tts.gen;
    u.onend = () => { if (g !== tts.gen) return; tts.ci++; speakNext(); };
    u.onerror = (e) => { if (g !== tts.gen) return; if (e.error === "interrupted" || e.error === "canceled") return; tts.ci++; setTimeout(speakNext, 50); };
    synth.speak(u);
  }
  function startReading(fromP) {
    if (!synth) { toast("Sorry, this browser cannot read aloud."); return; }
    loadVoices();
    const ps = Array.from(paraEls());
    const p = fromP || visiblePara();
    tts.s = cur; tts.pi = Math.max(0, ps.indexOf(p)); tts.chunks = null; tts.recent = [];
    tts.on = true; tts.paused = false; tts.gen++;
    synth.cancel();
    $("player").hidden = false; document.body.classList.add("playing");
    updatePlayBtn();
    speakNext();
  }
  function stopReading() {
    tts.on = false; tts.paused = false; tts.gen++;
    if (synth) synth.cancel();
    clearShow(); $("player").hidden = true; document.body.classList.remove("playing");
  }
  function togglePause() {
    if (!tts.on) return startReading();
    tts.paused = !tts.paused; tts.gen++;
    synth.cancel();             // cancel + replay the sentence is more reliable than pause() on phones
    if (!tts.paused) speakNext();
    updatePlayBtn();
  }
  function skip(d) {
    if (!tts.on) return;
    tts.gen++; synth.cancel();
    const ps = paraEls();
    if (d < 0 && tts.ci > 0) tts.ci = 0;
    else { tts.pi = Math.max(0, Math.min(ps.length, tts.pi + d)); tts.chunks = null; }
    if (tts.chunks) { /* restart current paragraph */ }
    tts.paused = false; updatePlayBtn(); speakNext();
  }
  function updatePlayBtn() { $("plPlay").textContent = tts.paused ? "▶" : "❚❚"; $("plPlay").title = tts.paused ? "Play" : "Pause"; }

  // ----- voices dialog -----
  function buildVoicesDlg() {
    loadVoices();
    const rows = ROLES.map(([role, label]) => {
      const conf = db.settings.voices[role] || {};
      const dv = defaultVoice(role, 0);
      const sel = conf.uri || (dv && dv.voiceURI) || "";
      const opts = allVoices.map((v) => `<option value="${esc(v.voiceURI)}"${v.voiceURI === sel ? " selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("");
      const pitch = conf.pitch || DEF_PITCH[role];
      const popts = [[0.75, "Deep"], [0.85, "Low"], [0.9, "Slightly low"], [1, "Normal"], [1.05, "Slightly high"], [1.15, "High"], [1.3, "Very high"]]
        .map(([x, l]) => `<option value="${x}"${Math.abs(x - pitch) < 0.03 ? " selected" : ""}>${l}</option>`).join("");
      return `<div class="vrow" data-role="${role}"><div class="vl">${label}</div><select data-k="uri">${opts}</select><select data-k="pitch">${popts}</select><button type="button" class="btn small" data-test>▶ Test</button></div>`;
    }).join("");
    $("vRows").innerHTML = allVoices.length ? rows : `<p class="hint">No English voices found on this device. On iPhone/Mac: Settings → Accessibility → Spoken Content → Voices. On Windows: Settings → Time &amp; language → Speech.</p>`;
  }
  const SAMPLE = { narrator: "It was a cold morning in early spring.", holmes: "You have been in Afghanistan, I perceive.", watson: "How on earth did you know that?", woman: "I have come to you, Mr. Holmes, because I am in trouble.", man: "I am Inspector Lestrade of Scotland Yard." };
  $("vRows").addEventListener("change", (e) => {
    const row = e.target.closest(".vrow"); if (!row) return;
    const role = row.dataset.role, conf = db.settings.voices[role] = db.settings.voices[role] || {};
    conf[e.target.dataset.k] = e.target.dataset.k === "pitch" ? +e.target.value : e.target.value;
    save();
  });
  $("vRows").addEventListener("click", (e) => {
    if (!e.target.matches("[data-test]")) return;
    const role = e.target.closest(".vrow").dataset.role;
    const who = role === "narrator" ? null : role === "woman" ? { key: "x:test", female: true } : role === "man" ? { key: "x:test" } : { key: role };
    const { v, pitch } = voiceFor(who);
    const conf = db.settings.voices[role] || {};
    const u = new SpeechSynthesisUtterance(SAMPLE[role]);
    if (v) u.voice = v; u.pitch = conf.pitch || pitch; u.rate = db.settings.rate;
    tts.gen++; synth.cancel(); synth.speak(u);
    if (tts.on) { tts.paused = true; updatePlayBtn(); }
  });
  $("vReset").onclick = () => { db.settings.voices = {}; save(); buildVoicesDlg(); };

  if (synth) {
    loadVoices();
    if ("onvoiceschanged" in synth) synth.addEventListener("voiceschanged", loadVoices);
    $("plRate").onchange = () => { db.settings.rate = +$("plRate").value; save(); if (tts.on && !tts.paused) { tts.gen++; synth.cancel(); speakNext(); } };
    $("plVoices").onclick = () => { buildVoicesDlg(); $("dlgVoices").showModal ? $("dlgVoices").showModal() : $("dlgVoices").setAttribute("open", ""); };
    window.addEventListener("pagehide", () => synth.cancel());
  }

  // ---------- human audiobook (LibriVox recordings, streamed from archive.org) ----------
  const aud = { on: false, unit: null, ti: 0, align: null, words: null, el: new Audio(), raf: 0, lastPid: null };
  aud.el.preload = "auto";
  window.sherlockAudio = aud.el;   // handy for debugging in the console
  let audioMap = null;
  const alignCache = {};
  async function loadAudioMap() {
    if (audioMap) return audioMap;
    const el = document.getElementById("audio-data");
    try { audioMap = el ? JSON.parse(el.textContent) : await (await fetch("book/audio.json")).json(); }
    catch (e) { audioMap = { recordings: {}, sections: {} }; }
    return audioMap;
  }
  async function loadAlign(key) {
    if (key in alignCache) return alignCache[key];
    const el = document.getElementById("align-data");
    let data = null;
    if (el) data = JSON.parse(el.textContent)[key] || null;
    else { try { const r = await fetch(`book/align/${key}.json`); if (r.ok) data = await r.json(); } catch (e) {} }
    return (alignCache[key] = data);
  }
  // The recording that covers a section: its tracks and every section it spans
  // (some stories are split into chapters but recorded as one file).
  function unitFor(id) {
    if (!audioMap || !book.sections[id]) return null;
    const S = book.sections, sameStory = (a, b) => S[a].path.length === 3 && S[b].path.length === 3 && S[a].path[0] === S[b].path[0] && S[a].path[1] === S[b].path[1];
    let first = id;
    while (!audioMap.sections[first] && first > 0 && sameStory(first - 1, id)) first--;
    if (!audioMap.sections[first]) return null;
    const secs = [first];
    for (let k = first + 1; k < S.length && !audioMap.sections[k] && sameStory(k, first); k++) secs.push(k);
    if (!secs.includes(id)) return null;
    return { key: first, tracks: audioMap.sections[first], secs, rec: audioMap.recordings[S[first].path[0]] };
  }
  // Without exact timings, estimate: words are spread evenly over each file,
  // skipping the LibriVox announcement at the start and end.
  const INTRO = 20, OUTRO = 12;
  function unitWords(u) {
    if (u.wc) return u.wc;
    const list = []; let total = 0;
    u.secs.forEach((sid) => book.sections[sid].paras.forEach(([pid, h]) => {
      const n = h.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
      list.push({ sid, pid, start: total, n }); total += n;
    }));
    return (u.wc = { list, total: Math.max(1, total) });
  }
  function speechLen(t) { return t > 120 ? t - INTRO - OUTRO : t; }
  function estTime(u, frac) {
    const spans = u.tracks.map((tr) => speechLen(tr.t || 1));
    let target = frac * spans.reduce((a, b) => a + b, 0);
    for (let i = 0; i < spans.length; i++) {
      if (target <= spans[i] || i === spans.length - 1) return { ti: i, t: Math.min(target, spans[i]) + (u.tracks[i].t > 120 ? INTRO : 0) };
      target -= spans[i];
    }
  }
  function estFrac(u, ti, t) {
    const spans = u.tracks.map((tr) => speechLen(tr.t || 1));
    let before = 0;
    for (let i = 0; i < ti; i++) before += spans[i];
    const inTrack = Math.max(0, Math.min(spans[ti], t - (u.tracks[ti].t > 120 ? INTRO : 0)));
    return (before + inTrack) / spans.reduce((a, b) => a + b, 0);
  }

  function playTrack(ti, at) {
    aud.ti = ti;
    const tr = aud.unit.tracks[ti];
    if (aud.el.dataset.src !== tr.url) { aud.el.src = tr.url; aud.el.dataset.src = tr.url; }
    aud.el.playbackRate = db.settings.rate;
    const go = () => {
      try { aud.el.currentTime = at || 0; } catch (e) {}
      aud.el.play().catch((e) => { if (e.name === "NotAllowedError") { setPaused(true); toast("Tap ▶ to start the audio"); } });
    };
    if (aud.el.readyState >= 1) go(); else aud.el.addEventListener("loadedmetadata", go, { once: true });
  }
  async function startAudio(fromP) {
    await loadAudioMap();
    const u = unitFor(cur);
    if (!u) return false;
    stopAll();
    aud.unit = u; aud.on = true; aud.lastPid = null;
    aud.align = await loadAlign(u.key);
    const p = fromP || visiblePara();
    const pid = p ? +p.dataset.p : null;
    let ti = 0, t = 0;
    if (pid && aud.align) {
      const w = aud.align.w.find((x) => x[2] >= pid);
      if (w) { ti = w[0]; t = Math.max(0, w[1] - 0.3); }
    } else if (pid) {
      const wc = unitWords(u), e = wc.list.find((x) => x.pid === pid);
      if (e && e.start > 0) ({ ti, t } = estTime(u, e.start / wc.total));
    }
    $("player").hidden = false; document.body.classList.add("playing"); document.body.classList.add("audio-mode");
    $("plWho").textContent = "🎧 " + (u.rec && u.rec.dramatic ? "Full cast" : "Human reader");
    $("plWho").className = "who human";
    $("plWho").title = (u.rec ? u.rec.title + " – LibriVox (public domain). " : "") + (aud.align ? "Words follow the audio exactly." : "The highlight follows the paragraph (approximate).");
    setPaused(false);
    srcLabel();
    playTrack(ti, t);
    tick();
    return true;
  }
  function stopAudio() {
    if (!aud.on) return;
    aud.on = false; aud.el.pause(); cancelAnimationFrame(aud.raf);
    document.body.classList.remove("audio-mode");
  }
  function setPaused(paused) {
    $("plPlay").textContent = paused ? "▶" : "❚❚"; $("plPlay").title = paused ? "Play" : "Pause";
  }
  aud.el.addEventListener("play", () => setPaused(false));
  aud.el.addEventListener("pause", () => setPaused(true));
  aud.el.addEventListener("ended", () => {
    if (!aud.on) return;
    if (aud.ti < aud.unit.tracks.length - 1) return playTrack(aud.ti + 1, 0);
    // finished this recording: go on to the next part that has one
    let next = aud.unit.secs[aud.unit.secs.length - 1] + 1;
    while (next < book.sections.length && !unitFor(next)) next++;
    if (next >= book.sections.length) { stopAll(); return; }
    renderSection(next); toast("Next: " + book.sections[next].title);
    startAudio(null);
  });
  aud.el.addEventListener("error", () => { if (aud.on) toast("Could not load the audio – check your internet connection."); });

  function findWord(ti, t) {   // last aligned word starting at or before (track, time)
    const w = aud.align.w;
    let lo = 0, hi = w.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (w[m][0] < ti || (w[m][0] === ti && w[m][1] <= t)) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans >= 0 ? w[ans] : null;
  }
  function tick() {
    if (!aud.on) return;
    aud.raf = requestAnimationFrame(tick);
    if (!aud.unit.secs.includes(cur)) { stopAll(); return; }   // reader went to another chapter
    if (aud.el.paused && aud.lastPid) return;
    const t = aud.el.currentTime;
    let pid, a = null, b = null;
    if (aud.align) {
      const w = findWord(aud.ti, t);
      if (!w) return;
      [, , pid, a, b] = w;
    } else {
      const wc = unitWords(aud.unit), f = estFrac(aud.unit, aud.ti, t) * wc.total;
      const e = wc.list.find((x) => f >= x.start && f < x.start + x.n) || wc.list[wc.list.length - 1];
      pid = e.pid;
    }
    // multi-chapter recordings: turn the page when the audio reaches the next chapter
    let p = $("page").querySelector(`p[data-p="${pid}"]`);
    if (!p) {
      const sid = aud.unit.secs.find((s) => book.sections[s].paras.some((x) => x[0] === pid));
      if (sid != null && sid !== cur) { renderSection(sid); p = $("page").querySelector(`p[data-p="${pid}"]`); }
      if (!p) return;
    }
    if (pid !== aud.lastPid) {
      aud.lastPid = pid;
      showChunk(p, { a: 0, b: 0, who: null });
      if (hl) hl.clear();
      $("plWho").textContent = "🎧 " + (aud.unit.rec && aud.unit.rec.dramatic ? "Full cast" : "Human reader");
      $("plWho").className = "who human";
      db.last = { s: cur, p: pid }; save();
    }
    if (a != null) markWord(p, a, b);
  }

  // ---------- one player for both kinds of voices ----------
  const mode = () => (aud.on ? "audio" : tts.on ? "tts" : null);
  function stopAll() { stopAudio(); if (tts.on) stopReading(); else { clearShow(); $("player").hidden = true; document.body.classList.remove("playing"); } }
  async function listen(fromP) {
    hideFloat();
    if (db.settings.source !== "tts") {
      if (await startAudio(fromP)) return;
      if (synth) toast("No human recording for this part – using computer voices");
    }
    if (synth) { stopAudio(); startReading(fromP); }
    else toast("Sorry, this browser cannot read aloud.");
    srcLabel();
  }
  function srcLabel() {
    const human = mode() === "audio";
    $("plSrc").textContent = human ? "🤖 Computer" : "🎧 Human";
    $("plSrc").hidden = !human && !unitFor(cur);
    $("plSrc").title = human ? "Switch to computer voices" : "Switch to the human audiobook";
    $("plPrev").textContent = human ? "−10s" : "⏮"; $("plNext").textContent = human ? "+10s" : "⏭";
    $("plPrev").title = human ? "Back 10 seconds" : "Previous paragraph"; $("plNext").title = human ? "Forward 10 seconds" : "Next paragraph";
  }
  $("btnListen").onclick = () => (mode() ? stopAll() : listen());
  $("fRead").onclick = () => { const p = pending && pending.p; window.getSelection().removeAllRanges(); listen(p); };
  $("plStop").onclick = stopAll;
  $("plPlay").onclick = () => {
    if (mode() === "audio") { if (aud.el.paused) aud.el.play(); else aud.el.pause(); }
    else if (synth) togglePause();
  };
  $("plPrev").onclick = () => { if (mode() === "audio") aud.el.currentTime = Math.max(0, aud.el.currentTime - 10); else skip(-1); };
  $("plNext").onclick = () => { if (mode() === "audio") aud.el.currentTime += 10; else skip(1); };
  $("plRate").value = String(db.settings.rate);
  $("plRate").addEventListener("change", () => { aud.el.playbackRate = +$("plRate").value; });
  $("plSrc").onclick = () => {
    const p = $("page").querySelector("p.reading") || visiblePara();
    db.settings.source = mode() === "audio" ? "tts" : "audio"; save();
    stopAll();
    if (db.settings.source === "audio" && !unitFor(cur)) { toast("No human recording for this part"); db.settings.source = "tts"; save(); }
    toast(db.settings.source === "audio" ? "🎧 Human voices" : "🤖 Computer voices");
    listen(p);
  };
  loadAudioMap();
  if (!synth && !("Audio" in window)) { $("btnListen").hidden = true; $("fRead").hidden = true; }

  // ---------- learn first, then review with quizzes (spaced repetition) ----------
  const DAY = 86400000;
  db.reviewLog = db.reviewLog || {};          // "YYYY-MM-DD" -> cards reviewed that day
  if (db.settings.autoReview === undefined) db.settings.autoReview = true;
  db.settings.ai = db.settings.ai || { provider: "deepseek", key: "", model: "" };
  const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = () => dkey(new Date());
  const srsOf = (v) => (v.srs = v.srs || { due: 0, ivl: 0, ease: 2.5, reps: 0, lapses: 0 });
  // words saved before "learn first" existed and already reviewed count as learned
  db.vocab.forEach((v) => { if (v.learned === undefined && v.srs && v.srs.reps > 0) v.learned = true; });
  const toLearn = () => db.vocab.filter((v) => !v.learned).sort((a, b) => a.at - b.at);
  const dueList = () => db.vocab.filter((v) => v.learned && srsOf(v).due <= Date.now()).sort((a, b) => a.srs.due - b.srs.due);
  function nextMorning() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(5, 0, 0, 0); return d.getTime(); }
  function streak() {
    let n = 0;
    const d = new Date(), on = (k) => db.reviewLog[k] || (db.readLog || {})[k];
    if (!on(today())) d.setDate(d.getDate() - 1);   // today not done yet: count up to yesterday
    while (on(dkey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function nextIvl(s, ok) {
    if (!ok) return 0;
    return s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.max(s.ivl + 1, Math.round(s.ivl * s.ease));
  }
  const ivlText = (d) => d === 0 ? "again soon" : d === 1 ? "tomorrow" : d < 30 ? `in ${d} days` : d < 365 ? `in ${Math.round(d / 30)} months` : `in ${(d / 365).toFixed(1)} years`;
  function grade(v, ok) {
    const s = srsOf(v);
    if (!ok) { s.lapses++; s.reps = 0; s.ivl = 0; s.ease = Math.max(1.3, s.ease - 0.2); s.due = Date.now() + 10 * 60000; }
    else { s.ivl = nextIvl(s, true); s.reps++; s.due = Date.now() + s.ivl * DAY - 3600000; }
    db.reviewLog[today()] = (db.reviewLog[today()] || 0) + 1;
    save();
  }

  // ----- meanings: free dictionary + translation, or your AI -----
  const LANGS = { vietnamese: "vi", "tiếng việt": "vi", chinese: "zh", japanese: "ja", korean: "ko", thai: "th", spanish: "es", french: "fr", indonesian: "id" };
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = "HTTP " + r.status;
      try { const j = await r.json(); msg += " " + ((j.error && (j.error.message || j.error)) || j.message || ""); } catch (e) {}
      if (r.status === 401 || r.status === 403) msg += " (the key looks wrong)";
      if (r.status === 402) msg += " (no balance left on this account)";
      throw new Error(msg.trim());
    }
    return r.json();
  }
  async function dictLookup(word) {
    const w = word.toLowerCase().replace(/[^a-z'\- ]/g, "").trim();
    const tries = [w];
    if (/(ies)$/.test(w)) tries.push(w.replace(/ies$/, "y"));
    if (/(es|s)$/.test(w)) tries.push(w.replace(/es$/, ""), w.replace(/s$/, ""));
    if (/ed$/.test(w)) tries.push(w.replace(/d$/, ""), w.replace(/ed$/, ""));
    if (/ing$/.test(w)) tries.push(w.replace(/ing$/, ""), w.replace(/ing$/, "e"));
    for (const t of tries) {
      try {
        const j = await getJSON("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(t));
        const defs = [];
        j.forEach((e) => e.meanings.forEach((m) => m.definitions.forEach((d) => defs.push({ pos: m.partOfSpeech, def: d.definition, ex: d.example }))));
        if (defs.length) return { ipa: j[0].phonetic || "", defs: defs.slice(0, 6) };
      } catch (e) { /* try next form */ }
    }
    return null;
  }
  async function translate(text) {
    const code = LANGS[(db.settings.lang || "").toLowerCase()];
    if (!code) return "";
    try {
      const j = await getJSON(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${code}`);
      return (j.responseData && j.responseData.translatedText) || "";
    } catch (e) { return ""; }
  }
  const aiReady = () => !!(db.settings.ai && db.settings.ai.key);
  const AI_DEFAULT_MODEL = { deepseek: "deepseek-chat", gemini: "gemini-2.5-flash", claude: "claude-opus-5-5", openai: "gpt-4o-mini" };
  const askAI = (prompt, json) => askAIMsgs([{ role: "user", content: prompt }], json);
  // msgs: [{role: "user"|"assistant", content}]
  async function askAIMsgs(msgs, json) {
    const { provider, key } = db.settings.ai, model = db.settings.ai.model || AI_DEFAULT_MODEL[provider];
    let text = "";
    if (provider === "gemini") {
      const j = await getJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: json ? { responseMimeType: "application/json" } : {} }),
      });
      text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map((p) => p.text || "").join("");
    } else if (provider === "claude") {
      const j = await getJSON("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model, max_tokens: 2000, output_config: { effort: "low" }, messages: msgs }),
      });
      if (j.stop_reason === "refusal") throw new Error("The AI declined this request");
      text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    } else {
      // DeepSeek and OpenAI use the same request format
      const url = provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
      const j = await getJSON(url, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ model, messages: msgs, ...(json ? { response_format: { type: "json_object" } } : {}) }),
      });
      text = ((j.choices || [])[0] || { message: {} }).message.content || "";
    }
    if (!json) return text.trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Unexpected AI answer");
    return JSON.parse(m[0]);
  }
  const langName = () => db.settings.lang || "Vietnamese";
  // English first; the translation is optional (hidden behind a button unless "always show" is on)
  const showVi = () => !!db.settings.showVi;
  function viBlock(html) {
    if (!html) return "";
    return (showVi() ? "" : `<button type="button" class="link vi-show" data-show-vi>🌐 Show ${esc(langName())}</button>`) +
      `<div class="vi-wrap"${showVi() ? "" : " hidden"}>${html}</div>`;
  }
  const viLine = (t, cls) => t ? viBlock(`<div class="${cls || "rv-vi"}">🇻🇳 ${esc(t)}</div>`) : "";
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-show-vi]");
    if (b) { b.nextElementSibling.hidden = false; b.remove(); }
  });
  async function aiMeaning(v) {
    return askAI(`You help an English learner whose first language is ${langName()}. They are reading Sherlock Holmes (Victorian English).
Word or phrase: "${v.word}"
Sentence: "${v.sentence}"
Reply with JSON only: {"meaning": "what it means IN THIS SENTENCE, very simple English, max 15 words", "pos": "part of speech", "translation": "${langName()} translation of the word as used here", "example": "one short modern example sentence using it", "tip": "one short tip in simple English, e.g. whether it is old-fashioned or formal"}`, true);
  }
  // Fill in a meaning automatically (AI if set up, otherwise free dictionary + translation).
  const POS_SHORT = { adjective: "adj", noun: "noun", verb: "verb", adverb: "adv", preposition: "prep", conjunction: "conj", pronoun: "pron", interjection: "interj", phrase: "phrase", idiom: "idiom", "phrasal verb": "phrasal verb", determiner: "det" };
  const posShort = (p) => { if (!p) return ""; const k = p.toLowerCase().trim(); return POS_SHORT[k] || Object.entries(POS_SHORT).find(([l]) => k.startsWith(l))?.[1] || k.split(/[ ,(/]/)[0]; };
  // Meaning: AI first when it is set up; otherwise (or if AI fails) the free dictionary.
  async function enrich(v, force) {
    if (v._busy) return;
    const wantAI = aiReady() && (force || (v.meaningSrc !== "ai" && !v.aiTried));
    if (!wantAI && v.meaning && v.vi) return;
    v._busy = true;
    try {
      if (wantAI) {
        v.aiTried = true;
        try {
          const r = await aiMeaning(v);
          v.meaning = r.meaning || v.meaning; v.pos = r.pos || v.pos; v.vi = r.translation || v.vi;
          v.example = r.example || v.example; v.tip = r.tip || ""; v.meaningSrc = "ai"; v.grammar = "";
        } catch (e) { toast("AI helper: " + e.message + " – using the dictionary"); }
      }
      if (!v.meaning) {
        if (!v.defs) { const d = await dictLookup(v.word); if (d) { v.defs = d.defs; v.ipa = v.ipa || d.ipa; } }
        if (v.defs && v.defs.length) { v.meaning = v.defs[0].def; v.pos = v.pos || v.defs[0].pos; v.example = v.example || v.defs[0].ex || ""; v.meaningSrc = "dict"; }
      }
      if (!v.vi) v.vi = await translate(v.word);
      save();
    } finally { delete v._busy; }
  }
  // Grammar note for the word as used in its sentence (AI), or a short general note (no AI).
  const POS_INFO = {
    adj: "Adjective (tính từ): describes a noun – e.g. a <i>weak</i> man. Usually before a noun or after be/seem/become.",
    noun: "Noun (danh từ): a person, thing or idea. Can be singular/plural and follow a/the/my.",
    verb: "Verb (động từ): an action or state. Changes form for tense: go / went / gone / going.",
    adv: "Adverb (trạng từ): describes how/when/where – often ends in -ly (quickly).",
    prep: "Preposition (giới từ): shows place, time or relation – in, on, at, upon.",
    conj: "Conjunction (liên từ): joins words or clauses – and, but, nor, though.",
    pron: "Pronoun (đại từ): stands for a noun – he, she, it, whom.",
    phrase: "Phrase / idiom (cụm từ): several words used together with one meaning – learn it as a whole.",
    idiom: "Idiom (thành ngữ): the meaning is not the sum of the words – learn it as a whole.",
  };
  async function grammarFor(v) {
    if (v.grammar) return v.grammar;
    if (!aiReady()) return POS_INFO[posShort(v.pos)] || "Turn on ✨ AI helper to get a grammar explanation for this word in its sentence.";
    const g = await askAI(`Explain the grammar of "${v.word}" in this sentence from Sherlock Holmes: "${v.sentence}".
For an English learner (first language ${langName()}). Use short bullet points:
- part of speech here and its job in the sentence (what it describes/modifies)
- its other word forms (e.g. noun/verb/adj/adv forms, plural or past tense)
- one common pattern or collocation with it
${showVi() ? `- a ${langName()} note in one line
` : ""}Keep it under 90 words.`);
    v.grammar = g; save();
    return g;
  }

  // ----- the learn/review window -----
  const rv = { mode: "learn", queue: [], i: 0, done: 0, answered: false };
  const DISTRACT_DEFS = ["a large building where horses are kept", "to speak very quietly", "extremely happy and excited", "a small boat used on rivers",
    "feeling sleepy and tired", "a person who sells fish", "to move away quickly in fear", "very old and broken", "a type of warm winter coat",
    "to agree with someone politely", "a bright light in the sky", "a long journey by sea", "to borrow money from a bank", "slightly wet and cold",
    "a meal eaten late at night", "to laugh in a quiet way", "a tall wooden fence", "full of noise and people", "to forget something important", "a sudden loud sound"];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const meaningOf = (v) => v.meaning || v.note || "";
  function bookWords(n, len, avoid) {
    const out = new Set(), secs = book.sections;
    for (let tries = 0; out.size < n && tries < 400; tries++) {
      const s = secs[Math.floor(Math.random() * secs.length)], p = s.paras[Math.floor(Math.random() * s.paras.length)];
      const ws = p[1].replace(/<[^>]+>/g, " ").match(/[a-z]{4,}/g) || [];
      const w = ws[Math.floor(Math.random() * ws.length)];
      if (w && Math.abs(w.length - len) <= 2 && !avoid.has(w)) out.add(w);
    }
    return [...out];
  }
  function quizType(v) {
    const s = srsOf(v), has = !!meaningOf(v);
    const order = has ? ["mc", "fill", "type"] : ["fill"];
    return order[(s.reps + s.lapses) % order.length];
  }
  function startSession() {
    const learn = toLearn(), due = dueList();
    rv.queue = [...learn.map((v) => ({ v, kind: "learn" })), ...shuffle(due.slice(0, 30)).map((v) => ({ v, kind: quizType(v) }))];
    rv.i = 0; rv.done = 0;
    learn.forEach((v) => enrich(v).then(() => { const c = rv.queue[rv.i]; if (c && c.v === v && c.kind === "learn") showCard(); }));
  }
  function openReview() {
    startSession();
    const dlg = $("dlgReview");
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); }
    showCard();
  }
  function header() {
    const s = streak(), left = rv.queue.slice(rv.i), nl = left.filter((c) => c.kind === "learn").length;
    $("rvHead").innerHTML = `<span>🔥 ${s} ${s === 1 ? "day" : "days"}</span><span>${nl ? `📖 ${nl} to learn · ` : ""}🧠 ${left.length - nl} to review</span>`;
  }
  const say = (t) => `<button class="btn small say" data-say="${esc(t)}" title="Listen">🔊</button>`;
  function meaningBlock(v) {
    let h = "";
    if (v.meaning) {
      h += `<div class="rv-mean"><b>Meaning:</b> ${esc(v.meaning)} <span class="tag">${v.meaningSrc === "ai" ? "AI" : v.meaningSrc === "dict" ? "dictionary" : "mine"}</span></div>`;
      if (v.meaningSrc === "dict" && v.defs && v.defs.length > 1)
        h += `<details class="others"><summary>Not the right meaning? Choose another</summary>` + v.defs.map((d, i) => `<button class="def" data-def="${i}"><i>${esc(posShort(d.pos))}</i> ${esc(d.def)}</button>`).join("") + `</details>`;
    } else if (v._busy) h += `<div class="rv-mean hint">${aiReady() ? "✨ AI is writing the meaning…" : "Looking up the meaning…"}</div>`;
    else h += `<div class="rv-mean hint">No meaning found. ${aiReady() ? "" : "Write it in your note, or turn on ✨ AI helper."}</div>`;
    h += viLine(v.vi);
    if (v.example) h += `<div class="rv-ex">e.g. <i>${esc(v.example)}</i></div>`;
    if (v.tip) h += `<div class="rv-ex">💡 ${esc(v.tip)}</div>`;
    h += `<label class="rv-note">My note / meaning in my words<input data-rv-note value="${esc(v.note || "")}" placeholder="Optional"></label>`;
    return h;
  }
  function showCard() {
    header();
    const c = rv.queue[rv.i], body = $("rvBody");
    rv.answered = false;
    if (!c) {
      const next = db.vocab.filter((x) => x.learned).map((x) => srsOf(x).due).filter((d) => d > Date.now()).sort((a, b) => a - b)[0];
      body.innerHTML = db.vocab.length
        ? `<div class="rv-done"><div class="big">🎉</div><p><b>All done for now!</b></p><p class="hint">${rv.done ? `You practised ${rv.done} ${rv.done === 1 ? "word" : "words"}. ` : ""}${next ? "Next review: " + new Date(next).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : ""}</p></div>`
        : `<div class="rv-done"><p><b>No words yet.</b></p><p class="hint">Select a word while reading → ＋ Save word. You will learn it here first, then practise it from the next morning.</p></div>`;
      $("rvActions").innerHTML = `<button class="btn primary wide" data-close-review>Back to reading</button>`;
      return;
    }
    const v = c.v;
    if (c.kind === "learn") {
      body.innerHTML = `<div class="rv-card"><div class="rv-tag">📖 New word · ${esc(v.path)}</div>
        ${v.pos ? `<button class="pos" data-grammar title="Tap for grammar">${esc(posShort(v.pos))} ⓘ</button>` : ""}
        <div class="rv-word">${esc(v.word)} ${say(v.word)} ${v.ipa ? `<span class="ipa">${esc(v.ipa)}</span>` : ""}</div>
        <div class="grammar" id="grammarOut"></div>
        <blockquote>${highlight(v.sentence, v.word)} ${say(v.sentence)}</blockquote>
        ${meaningBlock(v)}
        <div class="rv-ai">${aiReady() ? `<button class="btn small" data-ai-explain>✨ Ask AI to explain</button>` : `<button class="link" data-ai-setup>✨ Turn on the AI helper for better explanations</button>`}<div class="ai-out" id="aiOut"></div></div></div>`;
      $("rvActions").innerHTML = `<button class="btn" data-skip>Later</button><button class="btn primary span3" data-learned>✓ I understand</button>`;
      return;
    }
    const m = meaningOf(v);
    if (c.kind === "mc") {
      const others = shuffle(db.vocab.filter((x) => x !== v && meaningOf(x) && meaningOf(x) !== m).map(meaningOf));
      const opts = shuffle([m, ...[...others, ...shuffle(DISTRACT_DEFS.slice())].slice(0, 2)]);
      c.answer = m;
      body.innerHTML = `<div class="rv-card"><div class="rv-tag">🧠 What does it mean here?</div>
        <div class="rv-word">${esc(v.word)} ${say(v.word)}</div>
        <blockquote>${highlight(v.sentence, v.word)}</blockquote>
        <div class="opts">${opts.map((o, i) => `<button class="opt" data-opt="${esc(o)}"><b>${"ABC"[i]}</b> ${esc(o)}</button>`).join("")}</div></div>`;
    } else if (c.kind === "fill") {
      const lw = v.word.toLowerCase();
      const others = shuffle(db.vocab.filter((x) => x.word.toLowerCase() !== lw).map((x) => x.word));
      const avoid = new Set([lw, ...v.sentence.toLowerCase().split(/\W+/)]);
      const pool = [...others, ...bookWords(4, v.word.length, avoid)].filter((w, i, a) => a.indexOf(w) === i && w.toLowerCase() !== lw);
      const opts = shuffle([v.word, ...pool.slice(0, 2)]);
      c.answer = v.word;
      body.innerHTML = `<div class="rv-card"><div class="rv-tag">🧠 Choose the missing word</div>
        <p class="rv-q">${cloze(v.sentence, v.word)}</p>
        ${m ? `<p class="hint">Hint: ${esc(m)}</p>` : ""}
        <div class="opts">${opts.map((o, i) => `<button class="opt" data-opt="${esc(o)}"><b>${"ABC"[i]}</b> ${esc(o)}</button>`).join("")}</div></div>`;
    } else {
      c.answer = v.word;
      body.innerHTML = `<div class="rv-card"><div class="rv-tag">🧠 Type the word</div>
        <div class="rv-mean big">${esc(m)}</div>${viLine(v.vi)}
        <p class="hint">Starts with “${esc(v.word.charAt(0))}” · ${v.word.length} letters</p>
        <form id="typeForm" class="typeform"><input id="typeIn" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the word…"><button class="btn primary">Check</button></form>
        <div id="typeRes"></div></div>`;
      setTimeout(() => $("typeIn") && $("typeIn").focus(), 50);
      $("typeForm").onsubmit = (e) => { e.preventDefault(); answer($("typeIn").value); };
    }
    $("rvActions").innerHTML = "";
  }
  function cloze(sentence, word) {
    const i = sentence.toLowerCase().indexOf(word.toLowerCase());
    if (i < 0) return esc(sentence) + ` <span class="blank">______</span>`;
    return esc(sentence.slice(0, i)) + `<span class="blank">______</span>` + esc(sentence.slice(i + word.length));
  }
  const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' -]/g, "").replace(/\s+/g, " ").trim();
  function answer(given) {
    const c = rv.queue[rv.i]; if (!c || rv.answered) return;
    rv.answered = true;
    const v = c.v, ok = norm(given) === norm(c.answer);
    $("rvBody").querySelectorAll(".opt").forEach((b) => {
      b.disabled = true;
      if (b.dataset.opt === c.answer) b.classList.add("right");
      else if (b.dataset.opt === given) b.classList.add("wrong");
    });
    if ($("typeIn")) $("typeIn").disabled = true;
    grade(v, ok); rv.done++;
    if (!ok) rv.queue.push({ v, kind: "fill" });   // practise again in this session, the easy way
    const s = srsOf(v);
    const fb = document.createElement("div");
    fb.className = "fb " + (ok ? "ok" : "no");
    fb.innerHTML = (ok ? `✅ Correct! You will see it ${ivlText(s.ivl)}.` : `❌ Not quite. The answer is <b>${esc(v.word)}</b>${c.kind === "type" && given.trim() ? ` (you wrote “${esc(given)}”)` : ""}.`) +
      `<blockquote>${highlight(v.sentence, v.word)} ${say(v.sentence)}</blockquote>` +
      (meaningOf(v) ? `<div class="rv-mean"><b>Meaning:</b> ${esc(meaningOf(v))}</div>` : "") + viLine(v.vi) +
      (!ok && aiReady() ? `<button class="btn small" data-ai-feedback="${esc(given)}">✨ Ask AI why</button><div class="ai-out" id="aiOut"></div>` : "");
    $("rvBody").querySelector(".rv-card").appendChild(fb);
    $("rvActions").innerHTML = `<button class="btn primary wide" data-next>Next →</button>`;
    updateReviewBadge();
  }
  function sayText(t) {
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(t);
    loadVoices();
    const vv = allVoices.length ? voiceFor(null).v : null;
    if (vv) u.voice = vv; u.lang = vv ? vv.lang : "en-GB"; u.rate = Math.min(1, db.settings.rate);
    synth.speak(u);
  }
  // tiny markdown for AI answers: **bold**, bullet lines, line breaks (text is escaped first)
  function fmtAI(t) {
    return esc(t).replace(/^#+\s*(.+)$/gm, "<b>$1</b>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^\s*[-*•]\s+/gm, "• ").replace(/\n/g, "<br>");
  }
  async function aiInto(promise) {
    const out = $("aiOut"); if (!out) return;
    out.textContent = "✨ Thinking…";
    try { out.innerHTML = fmtAI(await promise); }
    catch (e) { out.textContent = "AI helper error: " + e.message + ". Check your key in ✨ AI helper."; }
  }
  $("dlgReview").addEventListener("click", (e) => {
    const t = e.target.closest("button"); if (!t) return;
    const c = rv.queue[rv.i], v = c && c.v;
    if (t.dataset.say) sayText(t.dataset.say);
    else if (t.matches("[data-close-review]")) $("dlgReview").close();
    else if (t.matches("[data-grammar]")) {
      const out = $("grammarOut"); if (!out) return;
      if (out.innerHTML) { out.innerHTML = ""; return; }
      out.textContent = aiReady() ? "✨ Thinking…" : "";
      grammarFor(v).then((g) => { out.innerHTML = fmtAI(g); }).catch((e) => { out.textContent = "AI helper error: " + e.message; });
    }
    else if (t.matches("[data-learned]")) {
      v.learned = true; v.learnedAt = Date.now();
      Object.assign(srsOf(v), { due: nextMorning(), ivl: 0, reps: 0 });
      db.reviewLog[today()] = (db.reviewLog[today()] || 0) + 1;
      save(); rv.done++; rv.i++; showCard(); updateReviewBadge();
      toast(`“${v.word}” learned – first review tomorrow morning`);
    } else if (t.matches("[data-skip]")) { rv.i++; showCard(); }
    else if (t.dataset.def) { const d = v.defs[+t.dataset.def]; v.meaning = d.def; v.pos = d.pos; v.example = v.example || d.ex || ""; v.meaningSrc = "dict"; save(); showCard(); }
    else if (t.dataset.opt !== undefined) answer(t.dataset.opt);
    else if (t.matches("[data-next]")) { rv.i++; showCard(); }
    else if (t.matches("[data-ai-explain]")) {
      t.disabled = true;
      enrich(v, true).then(() => showCard());
      aiInto(askAI(`Explain to an English learner (first language ${langName()}) the word "${v.word}" as used in this sentence from Sherlock Holmes: "${v.sentence}". Give: the meaning here and the whole sentence in simple modern English${showVi() ? `, then a ${langName()} translation of the sentence` : ""}. Keep it short.`));
    } else if (t.dataset.aiFeedback !== undefined) {
      t.disabled = true;
      aiInto(askAI(`An English learner (first language ${langName()}) was practising the word "${v.word}" (meaning: ${meaningOf(v) || "see sentence"}). Sentence: "${v.sentence}". They answered "${t.dataset.aiFeedback}". In 3 short sentences, kindly explain the difference and give a memory trick. Write in simple English${showVi() ? `, then repeat the key point in ${langName()}` : ""}.`));
    } else if (t.matches("[data-ai-setup]")) { openAISetup(); }
  });
  $("dlgReview").addEventListener("change", (e) => {
    if (!e.target.matches("[data-rv-note]")) return;
    const c = rv.queue[rv.i]; if (c) { c.v.note = e.target.value.trim(); save(); }
  });
  document.addEventListener("keydown", (e) => {
    if (!$("dlgReview").open || e.target.closest("input")) return;
    if (/^[1-3]$/.test(e.key)) { const b = $("rvBody").querySelectorAll(".opt")[+e.key - 1]; if (b && !b.disabled) b.click(); }
    if (e.key === "Enter") { const n = $("rvActions").querySelector("[data-next],[data-learned]"); if (n) { e.preventDefault(); n.click(); } }
  });
  $("rvAuto").checked = db.settings.autoReview;
  $("rvAuto").onchange = () => { db.settings.autoReview = $("rvAuto").checked; save(); };
  $("btnReview").onclick = () => { closePanels(); openReview(); };
  function updateReviewBadge() {
    const n = dueList().length + toLearn().length;
    $("reviewCount").textContent = n; $("reviewCount").hidden = n === 0;
    const nl = toLearn().length, nd = dueList().length;
    $("btnReviewPanel").textContent = n ? `🧠 Learn & review (${nl ? nl + " new" : ""}${nl && nd ? ", " : ""}${nd ? nd + " to review" : ""})` : "🧠 Learn & review (nothing due)";
  }
  $("btnReviewPanel").onclick = () => { closePanels(); openReview(); };
  updateReviewBadge();
  setInterval(updateReviewBadge, 60000);

  // ----- AI helper settings (key stays on this device, never exported) -----
  function openAISetup() {
    const a = db.settings.ai;
    $("aiProvider").value = a.provider || "gemini"; $("aiKey").value = a.key || ""; $("aiModel").value = a.model || "";
    $("aiModel").placeholder = AI_DEFAULT_MODEL[$("aiProvider").value]; $("aiTest").textContent = "";
    const d = $("dlgAI"); if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  }
  $("dlgAI").addEventListener("close", () => { if ($("dlgTr").open && tr && tr.info && aiReady() && tr.info.meaningSrc !== "ai") lookupTr(tr);
    else if ($("dlgAsk").open && aiReady() && !ask.msgs.length) { $("askLog").innerHTML = ""; $("askInput").focus(); } });
  $("dlgAI").addEventListener("close", () => { if ($("dlgReview").open && rv.queue[rv.i] && rv.queue[rv.i].kind === "learn") showCard(); });
  $("aiProvider").onchange = () => { $("aiModel").placeholder = AI_DEFAULT_MODEL[$("aiProvider").value]; };
  $("btnAISetup").onclick = openAISetup;
  $("aiSave").onclick = async () => {
    db.settings.ai = { provider: $("aiProvider").value, key: $("aiKey").value.trim(), model: $("aiModel").value.trim() };
    save();
    if (!db.settings.ai.key) { $("aiTest").textContent = "AI helper is off."; return; }
    $("aiTest").textContent = "Testing…";
    try {
      const r = await askAI('Reply with JSON only: {"ok": true, "hello": "a one-line friendly greeting for an English learner"}', true);
      $("aiTest").textContent = "✅ Works! " + (r.hello || "");
    } catch (e) { $("aiTest").textContent = "❌ " + e.message + " – check the key and model."; }
  };

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
    if (storageOk && db.settings.autoReview && (dueList().length || toLearn().length)) setTimeout(openReview, 700);
    if (!storageOk) setTimeout(() => toast("This preview can\u2019t save bookmarks or words. Download the file and open it in your browser to save."), 600);
  }).catch((e) => {
    $("page").innerHTML = `<p class="loading">Could not open the book (${esc(e.message)}). Please reload the page.</p>`;
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    const hadSW = !!navigator.serviceWorker.controller;
    let reloaded = false;
    // a new version took over: reload once so the new app code is used right away
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadSW && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
})();
