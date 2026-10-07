import { parseText, parseLine, stringify, toggleComplete, dueOf, todayStr, isValidDate, ctimeOf, stripCtime, withCtime, nowStamp } from "./parser.js";
import {
  supportsFS, pickFile, createFile, readHandle, writeHandle,
  getRecents, getStoredHandle, verifyPermission, downloadText,
  queryGranted, saveContentSnapshot, loadContentSnapshot, clearContentSnapshot,
} from "./file-manager.js";

const $ = (id) => document.getElementById(id);

const SAMPLE = `(A) 2026-09-26 銀行に電話する +家計 @phone due:2026-09-30
(B) Goodwill の引き取りを予約する +GarageSale @phone
Post signs around the neighborhood +GarageSale
@GroceryStore pies due:2026-10-02
x 2026-09-25 2026-09-20 Tim のプルリクをレビューする +TodoTxt @github
2+2 の足し算を学ぶ pri:B
`;

// ---- state ----
let lines = [];
let fileName = "";
let fileHandle = null;      // FileSystemFileHandle | null (fallback時は null)
let pendingHandle = null;   // { handle, name } | null: 自動再リンク待ちのハンドル
let fallbackMode = !supportsFS;
let dirty = false;
let lastModified = 0;
let saveTimer = 0;
let editingIndex = -1;      // lines 配列上のインデックス
let editingCompleted = false; // 編集中タスクの完了状態（編集画面では変更不可、一覧のチェックで切替）
let editingCtime = null; // 編集中タスクの完了時刻スタンプ YYYY-MM-DD-HH-MM（表示はしないが保持する）
let editingCompletionDate = null; // 編集中タスクの完了日（表示はしないが保持する）
let deferredPrompt = null;

const filters = { q: "", project: "", context: "", priority: "", sort: "due" };

// ---- toast ----
let toastTimer = 0;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---- PWA更新の適用 ----
let updateReady = false;
function onUpdateReady(version) {
  if (updateReady) return;
  updateReady = true;
  console.info("PWA更新を検出:", version);
  // 編集ダイアログの未保存ドラフト以外はスナップショット済みのため安全に再読み込みできる
  if (!$("edit-dialog").open) {
    toast("新しいバージョンを適用します…");
    setTimeout(() => location.reload(), 800);
  } else {
    $("update-banner").hidden = false;
    toast("新しいバージョンがあります。保存後に再読み込みしてください");
  }
}

// ---- serialize / save ----
function serialize() {
  return lines.map((l) => l.raw).join("\n") + (lines.length ? "\n" : "");
}

function markDirty() {
  dirty = true;
  $("dirty-dot").classList.add("dirty");
  // 手動リトライ（ユーザー操作起点なら権限プロンプトが出せる）用に保存ボタンは常に表示
  $("btn-download").hidden = false;
  if ($("btn-relink")) $("btn-relink").hidden = !(fallbackMode && supportsFS);
  if (fallbackMode) {
    $("save-state").textContent = supportsFS ? "未保存（原本未更新）" : "未保存";
    $("btn-download").hidden = false;
  } else {
    $("save-state").textContent = "保存中…";
  }
  // スナップショットは即時・同期保存（閉じる直前の編集も失わない）
  saveContentSnapshot(fileName, serialize());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 600);
}

async function persist(notify = true) {
  const text = serialize();
  // disk成否に関わらずブラウザ内に永続化（次回起動時に自動復元される）
  saveContentSnapshot(fileName, text);
  if (!dirty) return true;
  if (fileHandle) {
    try {
      await writeHandle(fileHandle, text);
      const f = await fileHandle.getFile();
      lastModified = f.lastModified;
      dirty = false;
      $("dirty-dot").classList.remove("dirty");
      $("save-state").textContent = "保存済み ✓";
      // 直接保存できている間は再リンク不要。保存ボタンはクリーン時は隠す
      if ($("btn-relink")) $("btn-relink").hidden = true;
      $("btn-download").hidden = !fallbackMode;
      console.info(`[save] overwrote ${fileName} (${text.length} chars)`);
      if (notify) toast("更新完了しました");
      return true;
    } catch (e) {
      console.error(e);
      $("save-state").textContent = "保存失敗";
      // 逃げ道: ⬇保存(ユーザー操作起点なら権限を取り直せる)。再リンクも促す
      $("btn-download").hidden = false;
      if ($("btn-relink") && supportsFS) $("btn-relink").hidden = false;
      if (notify) toast("保存に失敗しました: " + (e.message ?? e));
      return false;
    }
  } else {
    // fallback: ハンドルなしでは原本を上書きできない。ダウンロード待ち
    $("save-state").textContent = supportsFS ? "未保存（原本未更新）" : "未保存";
    if ($("btn-relink") && supportsFS) $("btn-relink").hidden = false;
    console.info(`[save] no handle for ${fileName}: kept in snapshot only`);
    if (notify) toast("ブラウザに保存しました（原本未更新）");
    return false;
  }
}

// ---- view transition ----
// 画面切替（welcome⇔main）のみ transtion させる。一覧の再描画は即時更新
// （タイピング毎のアニメは煩わしく、ヘッドレス等の描画環境差異の影響も避ける）
function canTransition() {
  return typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
// dir: ""（薄い crossfade）/ "forward"（右から入る）/ "back"（左から戻る）
function transitionTo(update, dir = "") {
  if (dir) document.documentElement.dataset.vtDir = dir;
  const done = () => { delete document.documentElement.dataset.vtDir; };
  if (!canTransition()) { update(); done(); return; }
  try {
    document.startViewTransition(() => update()).finished.then(done, done);
  } catch {
    update(); done();
  }
}

// ---- open / close ----
function showWelcome(show, dir = "") {
  const cur = !$("welcome").hidden;
  const apply = () => {
    $("welcome").hidden = !show;
    $("welcome").style.display = show ? "" : "none";
    $("main").hidden = show;
    $("file-chip").hidden = show;
    $("btn-reload").hidden = true;
    $("btn-download").hidden = true;
    if ($("btn-relink")) $("btn-relink").hidden = true;
    if (!show) {
      $("file-chip").hidden = false;
      $("btn-download").hidden = !fallbackMode;
      if ($("btn-relink")) $("btn-relink").hidden = !(fallbackMode && supportsFS && fileName);
      $("btn-reload").hidden = !fileHandle;
    }
  };
  if (cur === show) { apply(); return; }
  transitionTo(apply, dir);
}

function loadText(name, text, handle) {
  fileName = name;
  fileHandle = handle ?? null;
  fallbackMode = !fileHandle && !supportsFS ? true : !handle;
  // supportsFS なのに handle なし = サンプル等の一時ファイル → fallback扱いで保存時は新規保存を促す
  if (!handle && supportsFS) fallbackMode = true;
  lines = parseText(text);
  lastModified = Date.now();
  dirty = false;
  $("file-name").textContent = name;
  $("dirty-dot").classList.remove("dirty");
  $("save-state").textContent = fileHandle ? "保存済み ✓" : (supportsFS ? "ブラウザ保存中（原本未更新）" : "ブラウザに自動保存中");
  showWelcome(false, "forward");
  // ハンドルなし（スナップショット復元・DnD・サンプル等）では原本に直接書けない旨を明示
  if (!handle) {
    console.info(`[open] ${name} without handle: direct save disabled (fallbackMode=${fallbackMode})`);
    if (supportsFS && name && name !== "sample-todo.txt") {
      toast("原本に直接保存するには🔗再リンクか📂選択し直しが必要です");
    }
  }
  // 画面遷移と同時の一覧描画はアニメ不要
  render();
  toast(`${name} を開きました (${lines.length}件)`);
}

async function closeFile() {
  lines = [];
  fileName = "";
  fileHandle = null;
  pendingHandle = null;
  dirty = false;
  await clearContentSnapshot();
  showWelcome(true, "back");
  refreshRecents();
}

// リロード後に失効した書き込み権限を、最初のユーザー操作時に自動で取り直す。
// ブラウザ制約上プロンプトには操作起点が必須のため、完全無人での再接続はできない。
// セッション内1回のみ試行し、拒否時は手動の再リンクボタンに委ねる
let autoRelinkDone = false;
function armAutoRelink() {
  if (!supportsFS || autoRelinkDone) return;
  autoRelinkDone = true;
  const tryGrant = async () => {
    const p = pendingHandle;
    if (!p || p.name !== fileName) return;
    try {
      if (await verifyPermission(p.handle, true)) {
        pendingHandle = null;
        fileHandle = p.handle;
        fallbackMode = false;
        dirty = true; // スナップショット内容を原本へフラッシュ
        showWelcome(false);
        if (await persist(false)) toast("原本への自動保存を再開しました");
      } else {
        pendingHandle = null;
        console.info("[relink] auto grant denied; use the relink button");
      }
    } catch (e) {
      console.warn("[relink] auto grant failed:", e);
      pendingHandle = null;
    }
  };
  window.addEventListener("pointerdown", tryGrant, { once: true });
  window.addEventListener("keydown", tryGrant, { once: true });
}

// ---- filtering / sorting ----
// 基本ソートは期日順: 期限あり（古い＝近い順）が上、期限なしは罫線区切りの下に表示する。
// 完了済みは末尾にまとめる。ファイル順オプションは廃止し、ファイル順は同順位時のタイ break のみ。
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function visibleLines() {
  const q = filters.q.trim().toLowerCase();
  let out = lines.map((l, i) => ({ l, i })).filter(({ l }) => {
    if (filters.project && !l.projects.includes(filters.project)) return false;
    if (filters.context && !l.contexts.includes(filters.context)) return false;
    if (filters.priority === "NONE" && l.priority) return false;
    else if (filters.priority && filters.priority !== "NONE" && l.priority !== filters.priority) return false;
    if (q && !l.raw.toLowerCase().includes(q)) return false;
    return true;
  });
  if (filters.sort === "priority") {
    const rank = (p) => (p ? p.charCodeAt(0) : 999);
    out.sort((a, b) =>
      (a.l.completed - b.l.completed) || (rank(a.l.priority) - rank(b.l.priority)) ||
      cmpStr(dueOf(a.l) ?? "9999", dueOf(b.l) ?? "9999") || (a.i - b.i));
  } else if (filters.sort === "created") {
    out.sort((a, b) =>
      (a.l.completed - b.l.completed) ||
      cmpStr(a.l.creationDate ?? "9999", b.l.creationDate ?? "9999") || (a.i - b.i));
  } else {
    // 期日順（基本・default）。未知値もこちらにフォールバックする。
    out.sort((a, b) => {
      if (a.l.completed !== b.l.completed) return a.l.completed - b.l.completed;
      if (!a.l.completed) {
        const da = dueOf(a.l), db = dueOf(b.l);
        const ha = da ? 0 : 1, hb = db ? 0 : 1;
        if (ha !== hb) return ha - hb;
        if (da && db && da !== db) return da < db ? -1 : 1;
        return a.i - b.i;
      }
      const da = dueOf(a.l) ?? "9999", db = dueOf(b.l) ?? "9999";
      if (da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    });
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlight(body, line) {
  // 空白区切りトークン単位で処理する。URL内の +/@ や "2+2"・"soandso@example.com"
  // の誤検出を防ぐ（仕様上 +/@ は空白の直後に置かれたもののみ有効）
  const parts = String(body).split(/(\s+)/);
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const tok = parts[k];
    if (tok === "" || /^\s+$/.test(tok)) { out.push(tok); continue; }
    // 有効な期日・完了時刻はメタ行に表示済みのため本文では省略する（不正値は温存）
    if (/^due:\d{4}-\d{2}-\d{2}$/.test(tok) && isValidDate(tok.slice(4))) {
      if (parts[k + 1] && /^\s+$/.test(parts[k + 1])) k++;
      else if (out.length && /^\s+$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    {
      const mCT = tok.match(/^ctime:(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/);
      if (mCT && isValidDate(mCT[1]) && +mCT[2] < 24 && +mCT[3] < 60) {
        if (parts[k + 1] && /^\s+$/.test(parts[k + 1])) k++;
        else if (out.length && /^\s+$/.test(out[out.length - 1])) out.pop();
        continue;
      }
    }
    // プロジェクト・コンテキストはメタ行に表示するため本文では省略する
    if (/^[+@]\S+$/.test(tok)) {
      if (parts[k + 1] && /^\s+$/.test(parts[k + 1])) k++;
      else if (out.length && /^\s+$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    // URL (http/https のみ。javascript: 等は対象外)
    const mUrl = tok.match(/^(https?:\/\/[^\s<]+)/i);
    if (mUrl) {
      let url = mUrl[1];
      let extra = tok.slice(url.length);
      // 末尾の句読点・閉じ括弧はリンク外とする
      const mTrail = url.match(/^(.*?)([.,;:!?)\]}'"]+)$/);
      if (mTrail && mTrail[1].length > "https://x".length) {
        url = mTrail[1];
        extra = mTrail[2] + extra;
      }
      const esc = escapeHtml(url);
      out.push(`<a href="${esc}" target="_blank" rel="noopener noreferrer">${esc}</a>${escapeHtml(extra)}`);
      continue;
    }
    let h = escapeHtml(tok);
    h = h.replace(/^(\+)(.+)$/, '<span class="tag-proj">$1$2</span>');
    h = h.replace(/^(@)(.+)$/, '<span class="tag-ctx">$1$2</span>');
    h = h.replace(/^(due:\S+)$/, (m) => {
      const v = m.slice(4);
      const overdue = /^\d{4}-\d{2}-\d{2}$/.test(v) && v < todayStr() && !line.completed;
      return `<span class="tag-due${overdue ? " overdue" : ""}">${m}</span>`;
    });
    out.push(h);
  }
  const html = out.join("");
  return html.trim() === "" ? "(空)" : html;
}

// ---- render ----
function appendTask(ul, { l, i }, time = null) {
  const li = document.createElement("li");
  li.className = "task" + (l.completed ? " done" : "");
  const due = dueOf(l);
  const overdue = due && due < todayStr() && !l.completed;
  li.innerHTML = `
    <input type="checkbox" ${l.completed ? "checked" : ""} aria-label="完了切替" />
    <div class="task-main">
      <div class="body">${highlight(l.body || escapeHtml("(空)"), l)}</div>
        <div class="meta">
          ${time ? `<span class="tl-time">${escapeHtml(time)}</span>` : ""}
          ${l.priority ? `<span class="pri pri-${l.priority}">${escapeHtml(l.priority)}</span>` : ""}
          ${l.projects.map((p) => `<span class="tag-proj">+${escapeHtml(p)}</span>`).join("")}
          ${l.contexts.map((c) => `<span class="tag-ctx">@${escapeHtml(c)}</span>`).join("")}
          ${l.creationDate ? `<span>作成 ${escapeHtml(l.creationDate)}</span>` : ""}
        ${l.completionDate ? `<span>完了 ${escapeHtml(l.completionDate)}</span>` : ""}
        ${due ? `<span class="tag-due${overdue ? " overdue" : ""}">〆 ${escapeHtml(due)}${overdue ? " 期限切れ" : ""}</span>` : ""}
      </div>
    </div>`;
  const cb = li.querySelector("input");
  cb.addEventListener("change", () => {
    lines[i] = { ...toggleComplete(l, cb.checked), index: i };
    reparse(i);
    markDirty(); render();
  });
  // 行タップで編集モーダルを開く（チェックボックス・リンクの操作は除外）
  li.addEventListener("click", (e) => {
    if (e.target.closest("input, a, button")) return;
    openEdit(i);
  });
  ul.appendChild(li);
}

function render() {
  // フィルタ選択肢の更新
  const projs = new Set(), ctxs = new Set();
  for (const l of lines) { l.projects.forEach((p) => projs.add(p)); l.contexts.forEach((c) => ctxs.add(c)); }
  fillSelect($("f-project"), "+ Project: すべて", [...projs].sort(), filters.project);
  fillSelect($("f-context"), "@ Context: すべて", [...ctxs].sort(), filters.context);

  const vis = visibleLines();
  const done = lines.filter((l) => l.completed).length;
  $("stats").textContent = `全 ${lines.length} 件 · 未完了 ${lines.length - done} 件 · 完了 ${done} 件 · 表示 ${vis.length} 件 · プロジェクト ${projs.size} · コンテキスト ${ctxs.size}`;

  const ul = $("task-list");
  ul.innerHTML = "";
  const incomplete = vis.filter(({ l }) => !l.completed);
  const complete = vis.filter(({ l }) => l.completed);
  // 未完了（期日順基本では期限あり→期限なしを罫線で区切る）
  const isDueMode = filters.sort !== "priority" && filters.sort !== "created";
  if (isDueMode) {
    const split = incomplete.findIndex(({ l }) => !dueOf(l));
    if (split > 0 && split < incomplete.length) {
      incomplete.slice(0, split).forEach((d) => appendTask(ul, d));
      ul.appendChild(makeSeparator("期限なし"));
      incomplete.slice(split).forEach((d) => appendTask(ul, d));
    } else {
      incomplete.forEach((d) => appendTask(ul, d));
    }
  } else {
    incomplete.forEach((d) => appendTask(ul, d));
  }
  // 完了履歴は常に包含し、日付グルーピングで表示する
  if (complete.length) {
    if (incomplete.length) ul.appendChild(makeSeparator("完了履歴"));
    appendCompletedGroups(ul, complete);
  }
  $("empty").innerHTML = "<p>該当するタスクがありません。</p>";
  $("empty").hidden = vis.length !== 0;
}

function makeSeparator(label) {
  const sep = document.createElement("li");
  sep.className = "due-separator";
  sep.setAttribute("aria-label", label);
  sep.innerHTML = `<hr /><span>--- ${escapeHtml(label)} ---</span><hr />`;
  return sep;
}

// ---- timeline: 完了日ごとのグルーピング表示 ----
function dayLabel(ds) {
  if (!ds) return "日付不明";
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(ds + "T00:00:00").getDay()];
  if (ds === fmt(t)) return `${ds}（${wd}・今日）`;
  if (ds === fmt(new Date(t.getTime() - 86400000))) return `${ds}（${wd}・昨日）`;
  return `${ds}（${wd}）`;
}

function appendCompletedGroups(ul, items) {
  const groups = new Map();
  for (const d of items) {
    const key = d.l.completionDate || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? 1 : -1;
  });
  for (const k of keys) {
    groups.get(k).sort((a, b) => {
      const ta = ctimeOf(a.l)?.time ?? "99:99";
      const tb = ctimeOf(b.l)?.time ?? "99:99";
      return ta < tb ? 1 : ta > tb ? -1 : a.i - b.i;
    });
  }
  for (const k of keys) {
    const header = document.createElement("li");
    header.className = "tl-date";
    header.innerHTML = `<span>${escapeHtml(dayLabel(k))}</span><span class="muted">${groups.get(k).length}件</span>`;
    ul.appendChild(header);
    for (const d of groups.get(k)) {
      appendTask(ul, d, ctimeOf(d.l)?.time ?? "--:--");
    }
  }
}

function fillSelect(sel, label, values, current) {
  const cur = current;
  sel.innerHTML = "";
  const o0 = document.createElement("option");
  o0.value = ""; o0.textContent = label;
  sel.appendChild(o0);
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = (sel === $("f-project") ? "+ " : "@ ") + v;
    sel.appendChild(o);
  }
  sel.value = values.includes(cur) ? cur : "";
}

function reparse(i) {
  lines[i] = { ...parseLine(lines[i].raw, i) };
}

// ---- add ----
function addRaw(raw) {
  raw = raw.trim();
  if (!raw) return;
  // 作成日がなければ今日を自動付与（todo.txtでは任意だが作成日ベースの運用に合わせる）
  let parsed = parseLine(raw, lines.length);
  if (!parsed.completed && !parsed.creationDate) {
    raw = parsed.priority
      ? `(${parsed.priority}) ${todayStr()} ${parsed.body}`
      : `${todayStr()} ${raw}`;
    parsed = parseLine(raw, lines.length);
  }
  // 完了済みとして追加する場合は完了日・完了時刻がなければ自動付与する
  if (parsed.completed && (!parsed.completionDate || !ctimeOf(parsed))) {
    const t = { ...parsed };
    if (!t.completionDate) t.completionDate = todayStr();
    if (!ctimeOf(parsed)) t.body = withCtime(t.body, nowStamp());
    parsed = parseLine(stringify(t), lines.length);
  }
  lines.push(parsed);
  markDirty(); render();
}

// ---- edit dialog ----
/** 期日欄の値を body の due:YYYY-MM-DD に反映する（todo.txt の key:value 拡張） */
function bodyWithDue(body, due) {
  const hasValidDue = /\bdue:\d{4}-\d{2}-\d{2}\b/.test(body);
  if (!due && !hasValidDue) return body; // 不正な due トークンは温存する
  let b = body.replace(/\bdue:\S+/g, "").replace(/\s{2,}/g, " ").trim();
  if (due) b = b ? `${b} due:${due}` : `due:${due}`;
  return b;
}

/** ダイアログの各欄から構造化タスクを組み立てる */
function readEditForm() {
  const t = {
    completed: editingCompleted,
    priority: $("ed-pri").value || null,
    creationDate: $("ed-created").value || null,
    // 完了日・完了時刻は表示しない。完了済みのままなら既存値を保持する
    completionDate: editingCompleted ? (editingCompletionDate || todayStr()) : null,
    body: withCtime(bodyWithDue($("ed-body").value.trim(), $("ed-due").value || null), editingCtime),
  };
  return t;
}

function openEdit(i) {
  editingIndex = i;
  const l = lines[i];
  $("edit-title").textContent = `タスク #${i + 1} を編集`;
  editingCompleted = l.completed;
  $("ed-pri").value = l.priority ?? "";
  $("ed-created").value = l.creationDate ?? "";
  editingCompletionDate = l.completionDate ?? null;
  // 完了時刻・タスク内容は表示用に分離する（ctime は保存時に再付与）
  const ct = ctimeOf(l);
  editingCtime = ct ? `${ct.date}-${ct.time.replace(":", "-")}` : null;
  $("ed-body").value = stripCtime(l.body);
  const d = l.fields?.due?.[0];
  $("ed-due").value = d && isValidDate(d) ? d : "";
  // 作成日が空の未完了タスクは今日で自動FILLする
  if (!l.creationDate && !l.completed) {
    $("ed-created").value = todayStr();
  }
  updatePreview();
  $("edit-dialog").showModal();
}

function updatePreview() {
  $("ed-preview").textContent = stringify(readEditForm());
}

function saveEdit() {
  if (editingIndex < 0) return;
  lines[editingIndex] = { ...parseLine(stringify(readEditForm()), editingIndex) };
  markDirty(); render();
}

// ---- recents ----
async function refreshRecents() {
  const wrap = $("recent-wrap");
  const ul = $("recent-list");
  ul.innerHTML = "";
  if (!supportsFS) { wrap.hidden = true; return; }
  const recents = await getRecents();
  if (!recents.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const r of recents) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = "📄 " + r.name;
    b.addEventListener("click", async () => {
      try {
        const found = await getStoredHandle(r.name);
        if (!found) { toast("ハンドルが見つかりません。再選択してください。"); return; }
        if (!(await verifyPermission(found.handle, false))) { toast("権限が拒否されました"); return; }
        const { text, lastModified: lm } = await readHandle(found.handle);
        // 最近ファイルからの再オープン時も書き込み権限を確保する（クリック中＝操作起点なのでプロンプト可）
        const writable = await verifyPermission(found.handle, true);
        lastModified = lm;
        pendingHandle = null;
        loadText(found.name, text, found.handle);
        if (!writable) toast("読み取り専用で開きました（書き込み権限が拒否されました）");
      } catch (e) {
        console.error(e);
        toast("開けませんでした。再選択してください: " + (e.message ?? e));
      }
    });
    li.appendChild(b);
    ul.appendChild(li);
  }
}

// ---- events ----
function bind() {
  $("btn-pick").addEventListener("click", async () => {
    if (supportsFS) {
      try {
        const { handle, name, text, lastModified: lm, writable } = await pickFile();
        lastModified = lm;
        pendingHandle = null;
        loadText(name, text, handle);
        if (!writable) toast("書き込み権限が拒否されました。閲覧のみになります");
      } catch (e) {
        if (e?.name !== "AbortError") toast("開けませんでした: " + (e.message ?? e));
      }
    } else {
      $("fallback-input").click();
    }
  });

  $("btn-new").addEventListener("click", async () => {
    if (supportsFS) {
      try {
        const { handle, name } = await createFile("todo.txt");
        pendingHandle = null;
        loadText(name, "", handle);
      } catch (e) {
        if (e?.name !== "AbortError") toast("作成できませんでした: " + (e.message ?? e));
      }
    } else {
      const name = prompt("ファイル名", "todo.txt") || "todo.txt";
      loadText(name, "", null);
    }
  });

  $("btn-sample").addEventListener("click", () => loadText("sample-todo.txt", SAMPLE, null));

  $("fallback-input").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    loadText(f.name, await f.text(), null);
    e.target.value = "";
  });

  $("btn-close").addEventListener("click", async () => {
    if (dirty && !confirm("未保存の変更があります。閉じますか？")) return;
    await closeFile();
  });
  $("btn-reload").addEventListener("click", async () => {
    if (!fileHandle) return;
    try {
      const { text, lastModified: lm } = await readHandle(fileHandle);
      lastModified = lm;
      lines = parseText(text);
      dirty = false;
      $("dirty-dot").classList.remove("dirty");
      $("save-state").textContent = "保存済み ✓";
      render();
      saveContentSnapshot(fileName, serialize());
      toast("ファイルから再読込しました");
    } catch (e) { toast("再読込に失敗: " + (e.message ?? e)); }
  });
  $("btn-download").addEventListener("click", async () => {
    // 手動保存（ユーザー操作起点なので権限プロンプトが出せる）。
    // 1) ハンドルあり → まず原本への上書きを試す 2) 失敗時のみ別名保存に進む 3) ハンドルなし → ダウンロード
    if (fileHandle && supportsFS) {
      dirty = true;
      $("save-state").textContent = "保存中…";
      if (await persist(false)) {
        toast("更新完了しました");
        return;
      }
      // persist内で失敗トースト済み。別名保存で逃がすか確認する
      if (!confirm("上書き保存に失敗しました。名前を付けて保存しますか？")) return;
      try {
        const { handle, name } = await createFile(fileName || "todo.txt");
        fileHandle = handle; fileName = name;
        fallbackMode = false;
        $("file-name").textContent = name;
        dirty = true;
        if (await persist(false)) toast("更新完了しました");
        else toast("別名保存しましたが上書きに失敗しました");
        showWelcome(false);
        render();
        return;
      } catch (e) { if (e?.name === "AbortError") return; else { toast("別名保存に失敗: " + (e.message ?? e)); return; } }
    }
    downloadText(fileName || "todo.txt", serialize());
    dirty = false;
    $("dirty-dot").classList.remove("dirty");
    $("save-state").textContent = "ダウンロード保存済み";
    toast("ダウンロードしました（原本への上書きではありません）");
  });
  // ハンドルなし状態から原本ファイルを選択し直して紐付ける（ユーザー操作起点＝権限取得可）
  if ($("btn-relink")) {
    $("btn-relink").addEventListener("click", async () => {
      if (!supportsFS) { toast("このブラウザは直接保存に未対応です。⬇保存でダウンロードしてください"); return; }
      try {
        const { handle, name, text, lastModified: lm, writable } = await pickFile();
        pendingHandle = null;
        // 同名ファイルならメモリ内容を優先して上書き、別名なら開き直す
        if (name === fileName && lines.length) {
          fileHandle = handle;
          fallbackMode = false;
          $("file-name").textContent = name;
          dirty = true;
          showWelcome(false);
          if (await persist(false)) toast(`${name} に再リンクして上書き保存しました`);
          else toast("再リンクしましたが保存に失敗しました");
          if (!writable) toast("書き込み権限が拒否されました。閲覧のみになります");
        } else {
          lastModified = lm;
          loadText(name, text, handle);
          if (!writable) toast("書き込み権限が拒否されました。閲覧のみになります");
        }
      } catch (e) {
        if (e?.name !== "AbortError") toast("開けませんでした: " + (e.message ?? e));
      }
    });
  }

  // 追加
  $("btn-add").addEventListener("click", () => {
    addRaw($("quick-add").value);
    $("quick-add").value = "";
    $("quick-add").focus();
  });
  $("quick-add").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { addRaw(e.target.value); e.target.value = ""; }
  });

  // フィルタ
  $("q").addEventListener("input", (e) => { filters.q = e.target.value; render(); });
  $("f-project").addEventListener("change", (e) => { filters.project = e.target.value; render(); });
  $("f-context").addEventListener("change", (e) => { filters.context = e.target.value; render(); });
  $("f-priority").addEventListener("change", (e) => { filters.priority = e.target.value; render(); });
  $("f-sort").addEventListener("change", (e) => {
    const v = e.target.value;
    filters.sort = (v === "priority" || v === "created") ? v : "due";
    e.target.value = filters.sort;
    render();
  });
  // 編集ダイアログの連動（構造化欄→プレビュー更新のみ）
  for (const id of ["ed-pri", "ed-created", "ed-due", "ed-body"]) {
    $(id).addEventListener("input", updatePreview);
  }
  $("ed-save").addEventListener("click", (e) => { e.preventDefault(); saveEdit(); $("edit-dialog").close(); });
  $("ed-delete").addEventListener("click", (e) => {
    e.preventDefault();
    if (editingIndex < 0) return;
    if (confirm("このタスクを削除しますか？\n" + lines[editingIndex].raw)) {
      lines.splice(editingIndex, 1);
      editingIndex = -1;
      markDirty(); render();
      $("edit-dialog").close();
    }
  });

  // DnD
  const dz = $("drop-zone");
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    // File System AccessハンドルはDropからは得られないためメモリ読み＋任意で関連付けは後から
    loadText(f.name, await f.text(), null);
  });

  // 外部変更の検出（FS API時のみ、3秒ポーリング）
  setInterval(async () => {
    if (!fileHandle || dirty) return;
    try {
      const f = await fileHandle.getFile();
      if (f.lastModified !== lastModified) {
        lastModified = f.lastModified;
        lines = parseText(await f.text());
        render();
        toast("外部の変更を反映しました");
      }
    } catch { /* ignore */ }
  }, 3000);

  // PWA install
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $("btn-install").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === "accepted") {
        toast("インストールを開始しました");
      } else {
        toast("メニューからいつでもインストールできます");
      }
    } catch (e) {
      console.warn("インストール開始に失敗:", e);
      toast("インストールを開始できませんでした: " + (e?.message ?? e));
    }
    deferredPrompt = null;
    $("btn-install").hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    $("btn-install").hidden = true;
    toast("インストールしました 🎉");
  });
}

// ---- init ----
async function init() {
  bind();
  $("quick-add").placeholder = `(A) ${todayStr()} 新しいタスク +Project @ctx due:2026-10-01（作成日は自動付与）`;
  $("compat-msg").textContent = supportsFS
    ? "このブラウザは File System Access API に対応しています。開いたファイルへの直接上書き保存が可能です。"
    : "このブラウザは File System Access API に未対応のため、ファイルを開く→編集→ダウンロード保存の方式になります（Chrome/Edge では直接保存が可能です）。";
  // 前回内容の自動復元（PWAを閉じても次回起動時は選択なしでそのまま開く）
  const snap = await loadContentSnapshot();
  if (snap && typeof snap.text === "string" && snap.name) {
    let restored = false;
    if (supportsFS) {
      try {
        const stored = await getStoredHandle(snap.name);
        if (stored) {
          if (await queryGranted(stored.handle, true)) {
            const { text, lastModified: lm } = await readHandle(stored.handle);
            loadText(stored.name, text, stored.handle);
            lastModified = lm;
            saveContentSnapshot(stored.name, text);
            toast("前回のファイルを自動で開きました");
            restored = true;
          } else {
            // 権限は失効しているがハンドルは残っている。最初の操作で自動再接続する
            pendingHandle = { handle: stored.handle, name: snap.name };
          }
        }
      } catch (e) { console.warn("ハンドル自動復元に失敗、スナップショットを使用:", e); }
    }
    if (!restored) {
      loadText(snap.name, snap.text, null);
      toast(pendingHandle
        ? "前回の内容を復元しました。最初の操作時に原本保存を再開します"
        : "前回の内容をブラウザから復元しました");
    }
    armAutoRelink();
  } else {
    showWelcome(true);
  }
  await refreshRecents();
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      // サーバー側の更新を定期チェック（1時間毎＋復帰時＋回線復帰時）。
      // 更新があれば新SWが即時activate→通知→下の onUpdateReady で適用する
      const checkUpdate = () => reg.update().catch(() => {});
      setInterval(checkUpdate, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkUpdate();
      });
      window.addEventListener("online", checkUpdate);
    } catch (e) {
      console.warn("Service Worker 登録失敗:", e);
    }
    // 更新SWからの通知を受けて新バージョンを適用する
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "SW_UPDATED") onUpdateReady(e.data.version);
    });
    // 更新バナーからの手動再読み込み／ダイアログを閉じたら保留中の更新を適用
    $("btn-update-reload").addEventListener("click", () => location.reload());
    $("edit-dialog").addEventListener("close", () => {
      if (updateReady) location.reload();
    });
  }
  // 終了前に未保存があれば警告（fallback時）
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  // 閉じる・バックグラウンド化の直前に保留中の保存をフラッシュする
  const flush = () => { clearTimeout(saveTimer); persist(false); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

init();
