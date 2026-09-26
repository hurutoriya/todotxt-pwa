import { parseText, parseLine, stringify, toggleComplete, dueOf, todayStr } from "./parser.js";
import {
  supportsFS, pickFile, createFile, readHandle, writeHandle,
  getRecents, getStoredHandle, verifyPermission, downloadText,
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
let fallbackMode = !supportsFS;
let dirty = false;
let lastModified = 0;
let saveTimer = 0;
let editingIndex = -1;      // lines 配列上のインデックス
let deferredPrompt = null;

const filters = { q: "", project: "", context: "", priority: "", showDone: true, sort: "default" };

// ---- toast ----
let toastTimer = 0;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---- serialize / save ----
function serialize() {
  return lines.map((l) => l.raw).join("\n") + (lines.length ? "\n" : "");
}

function markDirty() {
  dirty = true;
  $("dirty-dot").classList.add("dirty");
  $("btn-download").hidden = !fallbackMode ? true : false;
  if (fallbackMode) {
    $("save-state").textContent = "未保存";
    $("btn-download").hidden = false;
  } else {
    $("save-state").textContent = "保存中…";
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 600);
}

async function persist() {
  if (!dirty && fileHandle) return;
  const text = serialize();
  if (fileHandle) {
    try {
      await writeHandle(fileHandle, text);
      const f = await fileHandle.getFile();
      lastModified = f.lastModified;
      dirty = false;
      $("dirty-dot").classList.remove("dirty");
      $("save-state").textContent = "保存済み ✓";
    } catch (e) {
      console.error(e);
      $("save-state").textContent = "保存失敗";
      toast("保存に失敗しました: " + (e.message ?? e));
    }
  } else {
    // fallback: ダウンロード待ち
    $("save-state").textContent = "未保存";
  }
}

// ---- open / close ----
function showWelcome(show) {
  $("welcome").hidden = !show;
  $("welcome").style.display = show ? "" : "none";
  $("main").hidden = show;
  $("file-chip").hidden = show;
  $("btn-reload").hidden = true;
  $("btn-download").hidden = true;
  if (!show) {
    $("file-chip").hidden = false;
    $("btn-download").hidden = !fallbackMode;
    $("btn-reload").hidden = !fileHandle;
  }
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
  $("save-state").textContent = fileHandle ? "保存済み ✓" : "メモリ上 (要ダウンロード保存)";
  showWelcome(false);
  render();
  toast(`${name} を開きました (${lines.length}件)`);
}

function closeFile() {
  lines = [];
  fileName = "";
  fileHandle = null;
  dirty = false;
  showWelcome(true);
  refreshRecents();
}

// ---- filtering / sorting ----
function visibleLines() {
  const q = filters.q.trim().toLowerCase();
  let out = lines.map((l, i) => ({ l, i })).filter(({ l }) => {
    if (l.completed && !filters.showDone) return false;
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
      ((dueOf(a.l) ?? "9999") < (dueOf(b.l) ?? "9999") ? -1 : 1) || (a.i - b.i));
  } else if (filters.sort === "due") {
    out.sort((a, b) =>
      (a.l.completed - b.l.completed) ||
      ((dueOf(a.l) ?? "9999") < (dueOf(b.l) ?? "9999") ? -1 : 1) || (a.i - b.i));
  } else if (filters.sort === "created") {
    out.sort((a, b) =>
      (a.l.completed - b.l.completed) ||
      ((a.l.creationDate ?? "9999") < (b.l.creationDate ?? "9999") ? -1 : 1) || (a.i - b.i));
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlight(body, line) {
  let h = escapeHtml(body);
  h = h.replace(/(\+)([^\s]+)/g, '<span class="tag-proj">$1$2</span>');
  h = h.replace(/(@)([^\s]+)/g, '<span class="tag-ctx">$1$2</span>');
  h = h.replace(/\b(due:[^\s<]+)/g, (m) => {
    const v = m.slice(4);
    const overdue = /^\d{4}-\d{2}-\d{2}$/.test(v) && v < todayStr() && !line.completed;
    return `<span class="tag-due${overdue ? " overdue" : ""}">${m}</span>`;
  });
  return h;
}

// ---- render ----
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
  for (const { l, i } of vis) {
    const li = document.createElement("li");
    li.className = "task" + (l.completed ? " done" : "");
    const due = dueOf(l);
    const overdue = due && due < todayStr() && !l.completed;
    li.innerHTML = `
      <input type="checkbox" ${l.completed ? "checked" : ""} aria-label="完了切替" />
      ${l.priority ? `<span class="pri pri-${l.priority}">${escapeHtml(l.priority)}</span>` : ""}
      <div class="task-main">
        <div class="body">${highlight(l.body || escapeHtml("(空)"), l)}</div>
        <div class="meta">
          ${l.creationDate ? `<span>作成 ${escapeHtml(l.creationDate)}</span>` : ""}
          ${l.completionDate ? `<span>完了 ${escapeHtml(l.completionDate)}</span>` : ""}
          ${due ? `<span class="tag-due${overdue ? " overdue" : ""}">〆 ${escapeHtml(due)}${overdue ? " 期限切れ" : ""}</span>` : ""}
        </div>
      </div>
      <div class="task-actions">
        <button title="編集">✏️</button>
        <button title="削除">🗑️</button>
      </div>`;
    const [cb, btnEdit, btnDel] = [li.querySelector("input"), ...li.querySelectorAll(".task-actions button")];
    cb.addEventListener("change", () => {
      lines[i] = { ...toggleComplete(l, cb.checked), index: i };
      reparse(i);
      markDirty(); render();
    });
    btnEdit.addEventListener("click", () => openEdit(i));
    btnDel.addEventListener("click", () => {
      if (confirm("このタスクを削除しますか？\n" + l.raw)) {
        lines.splice(i, 1);
        markDirty(); render();
      }
    });
    ul.appendChild(li);
  }
  $("empty").hidden = vis.length !== 0;
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
  lines.push(parsed);
  markDirty(); render();
}

// ---- edit dialog ----
function openEdit(i) {
  editingIndex = i;
  const l = lines[i];
  $("edit-title").textContent = `タスク #${i + 1} を編集`;
  $("ed-raw").value = l.raw;
  $("ed-done").checked = l.completed;
  $("ed-pri").value = l.priority ?? "";
  $("ed-created").value = l.creationDate ?? "";
  $("ed-completed").value = l.completionDate ?? "";
  $("ed-body").value = l.body;
  // 作成日が空の未完了タスクは今日で自動FILLし、raw欄にも反映する
  if (!l.creationDate && !l.completed) {
    $("ed-created").value = todayStr();
    $("ed-raw").value = stringify({
      completed: false,
      priority: $("ed-pri").value || null,
      creationDate: todayStr(),
      completionDate: null,
      body: $("ed-body").value.trim(),
    });
  }
  updatePreview();
  $("edit-dialog").showModal();
}

function updatePreview() {
  const t = {
    completed: $("ed-done").checked,
    priority: $("ed-pri").value || null,
    creationDate: $("ed-created").value || null,
    completionDate: $("ed-completed").value || null,
    body: $("ed-body").value.trim(),
  };
  if (t.completed && !t.completionDate) t.completionDate = todayStr();
  $("ed-preview").textContent = stringify(t);
}

function saveEdit() {
  if (editingIndex < 0) return;
  const raw = $("ed-raw").value.trim();
  // raw欄がプレビューと一致しない＝直接raw編集とみなしてそのまま採用、構造不整合でも仕様上許容
  const preview = $("ed-preview").textContent.trim();
  const finalRaw = raw === lines[editingIndex].raw || raw === preview ? preview : raw || preview;
  lines[editingIndex] = { ...parseLine(finalRaw, editingIndex) };
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
        const { text } = await readHandle(found.handle);
        loadText(found.name, text, found.handle);
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
        const { handle, name, text, lastModified: lm } = await pickFile();
        lastModified = lm;
        loadText(name, text, handle);
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

  $("btn-close").addEventListener("click", () => {
    if (dirty && !confirm("未保存の変更があります。閉じますか？")) return;
    closeFile();
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
      toast("ファイルから再読込しました");
    } catch (e) { toast("再読込に失敗: " + (e.message ?? e)); }
  });
  $("btn-download").addEventListener("click", async () => {
    if (fileHandle && supportsFS) {
      // 「名前を付けて保存」でハンドルを付け替えたい場合
      try {
        const { handle, name } = await createFile(fileName || "todo.txt");
        fileHandle = handle; fileName = name;
        fallbackMode = false;
        $("file-name").textContent = name;
        await persist();
        dirty = false;
        showWelcome(false);
        render();
        return;
      } catch (e) { if (e?.name === "AbortError") return; }
    }
    downloadText(fileName || "todo.txt", serialize());
    dirty = false;
    $("dirty-dot").classList.remove("dirty");
    $("save-state").textContent = "ダウンロード保存済み";
    toast("ダウンロードしました");
  });

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
  $("f-sort").addEventListener("change", (e) => { filters.sort = e.target.value; render(); });
  $("f-show-done").addEventListener("change", (e) => { filters.showDone = e.target.checked; render(); });
  $("btn-archive").addEventListener("click", () => {
    const doneLines = lines.filter((l) => l.completed);
    if (!doneLines.length) { toast("完了タスクはありません"); return; }
    if (!confirm(`${doneLines.length} 件の完了タスクを除去しますか？\n(done.txt として別保存したい場合はキャンセル後ダウンロードしてください)`)) return;
    downloadText("done.txt", doneLines.map((l) => l.raw).join("\n") + "\n");
    lines = lines.filter((l) => !l.completed);
    markDirty(); render();
    toast("完了タスクを done.txt に保存し、一覧から除去しました");
  });

  // 編集ダイアログの連動
  for (const id of ["ed-done", "ed-pri", "ed-created", "ed-completed", "ed-body"]) {
    $(id).addEventListener("input", () => {
      // body/構造を変えたら raw にも反映してプレビュー更新
      if (id !== "ed-raw") {
        const t = {
          completed: $("ed-done").checked,
          priority: $("ed-pri").value || null,
          creationDate: $("ed-created").value || null,
          completionDate: $("ed-completed").value || null,
          body: $("ed-body").value.trim(),
        };
        if (t.completed && !t.completionDate) t.completionDate = todayStr();
        $("ed-raw").value = stringify(t);
      } else {
        // raw直編集時は構造欄へ逆反映
        try {
          const p = parseLine($("ed-raw").value);
          $("ed-done").checked = p.completed;
          $("ed-pri").value = p.priority ?? "";
          $("ed-created").value = p.creationDate ?? "";
          $("ed-completed").value = p.completionDate ?? "";
          $("ed-body").value = p.body;
        } catch { /* ignore */ }
      }
      updatePreview();
    });
  }
  // raw欄は上ループに含まれていないので別途
  $("ed-raw").addEventListener("input", () => {
    try {
      const p = parseLine($("ed-raw").value);
      $("ed-done").checked = p.completed;
      $("ed-pri").value = p.priority ?? "";
      $("ed-created").value = p.creationDate ?? "";
      $("ed-completed").value = p.completionDate ?? "";
      $("ed-body").value = p.body;
    } catch { /* ignore */ }
    updatePreview();
  });
  $("ed-save").addEventListener("click", (e) => { e.preventDefault(); saveEdit(); $("edit-dialog").close(); });

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
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("btn-install").hidden = true;
  });
}

// ---- init ----
async function init() {
  bind();
  showWelcome(true);
  $("quick-add").placeholder = `(A) ${todayStr()} 新しいタスク +Project @ctx due:2026-10-01（作成日は自動付与）`;
  $("compat-msg").textContent = supportsFS
    ? "このブラウザは File System Access API に対応しています。開いたファイルへの直接上書き保存が可能です。"
    : "このブラウザは File System Access API に未対応のため、ファイルを開く→編集→ダウンロード保存の方式になります（Chrome/Edge では直接保存が可能です）。";
  await refreshRecents();
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.warn("Service Worker 登録失敗:", e);
    }
  }
  // 終了前に未保存があれば警告（fallback時）
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

init();
