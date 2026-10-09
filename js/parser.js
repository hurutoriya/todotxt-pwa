// todo.txt parser — https://github.com/todotxt/todo.txt 準拠
// 形式:
//   完了:      x <completion-date?> <creation-date?> body
//   未完了:    [(PRI)] [creation-date] body
//   body内: +project @context key:value を任意位置に含められる

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 1行をパースする。空行は { raw:"", empty:true } を返す。
 */
export function parseLine(raw, index = 0) {
  const line = { index, raw, empty: false, completed: false, priority: null, completionDate: null, creationDate: null, body: "", projects: [], contexts: [], fields: {} };
  if (!raw || !raw.trim()) { line.empty = true; return line; }

  let rest = raw.trim();

  // Rule: 完了は先頭 "x " (小文字x + 半角スペース)
  const mDone = rest.match(/^x\s+(.*)$/);
  if (mDone) {
    line.completed = true;
    rest = mDone[1].trim();
    // 完了日の直後に日付があれば completionDate、その次も日付なら creationDate
    const parts = rest.split(/\s+/);
    let i = 0;
    if (parts[i] && isValidDate(parts[i])) { line.completionDate = parts[i]; i++; }
    if (parts[i] && isValidDate(parts[i])) { line.creationDate = parts[i]; i++; }
    line.body = parts.slice(i).join(" ");
  } else {
    // 未完了: (A) が先頭にあれば優先度
    const mPri = rest.match(/^\(([A-Z])\)\s+(.*)$/);
    if (mPri) {
      line.priority = mPri[1];
      rest = mPri[2].trim();
    }
    // 優先度の直後の日付は作成日
    const mDate = rest.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
    if (mDate && isValidDate(mDate[1])) {
      line.creationDate = mDate[1];
      line.body = mDate[2].trim();
    } else {
      line.body = rest;
    }
    // "(A) 2011-03-02 Call" の逆パターン "(A) Call 2011-03-02" は作成日なしとして扱う（仕様通り）
  }

  // body 内のメタ抽出（表示用。body自体は保持する）
  const projects = new Set();
  const contexts = new Set();
  const fields = {};
  for (const tok of line.body.split(/\s+/)) {
    if (tok.startsWith("+") && tok.length > 1) projects.add(tok.slice(1));
    else if (tok.startsWith("@") && tok.length > 1) contexts.add(tok.slice(1));
    else {
      const ci = tok.indexOf(":");
      if (ci > 0 && ci < tok.length - 1 && !tok.includes("://")) {
        const k = tok.slice(0, ci);
        const v = tok.slice(ci + 1);
        if (/^[^\s:]+$/.test(k) && /^[^\s:]+$/.test(v)) {
          (fields[k] ??= []).push(v);
        }
      }
    }
  }
  line.projects = [...projects];
  line.contexts = [...contexts];
  line.fields = fields;
  return line;
}

export function parseText(text) {
  const normalized = (text ?? "").replace(/\r\n?/g, "\n");
  // 末尾改行のみの空行は無視するが、途中空行は保持しない（todo.txtでは空行は無意味）
  return normalized.split("\n").map((raw, i) => parseLine(raw, i)).filter((l) => !l.empty);
}

/** 構造化タスクから正規の1行を生成する */
export function stringify(task) {
  const parts = [];
  if (task.completed) {
    parts.push("x");
    if (task.completionDate) parts.push(task.completionDate);
    if (task.creationDate) parts.push(task.creationDate);
    if (task.body) parts.push(task.body);
  } else {
    if (task.priority) parts.push(`(${task.priority})`);
    if (task.creationDate) parts.push(task.creationDate);
    if (task.body) parts.push(task.body);
  }
  return parts.join(" ").trim();
}

export function toggleComplete(line, done = !line.completed) {
  const t = { ...line };
  t.completed = done;
  if (done) {
    t.completionDate = t.completionDate || todayStr();
    // 分単位の完了時刻を ctime 拡張に記録（仕様の日付枠は YYYY-MM-DD のまま）
    t.body = withCtime(t.body, nowStamp());
  } else {
    // 未完了に戻すときは完了日・完了時刻を落とし、作成日は残す（仕様の運用に合わせる）
    t.completionDate = null;
    t.body = withCtime(t.body, null);
  }
  return { ...t, raw: stringify({ ...t }) };
}

export function dueOf(line) {
  const v = line.fields?.due?.[0];
  return v && isValidDate(v) ? v : null;
}

/** 現在時刻を YYYY-MM-DD-HH-MM 形式で返す（完了時刻の記録用） */
export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

/** ctime 拡張値を { date, time } で返す。不正なら null */
export function ctimeOf(line) {
  const v = line.fields?.ctime?.[0];
  const m = typeof v === "string" && v.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/);
  if (!m || !isValidDate(m[1]) || +m[2] > 23 || +m[3] > 59) return null;
  return { date: m[1], time: `${m[2]}:${m[3]}` };
}

export function stripCtime(body) {
  return body.replace(/\bctime:\S+/g, "").replace(/\s{2,}/g, " ").trim();
}

/** 有効な期日トークン due:YYYY-MM-DD のみを取り除く。不正な due:xxx は本文メモとして温存する */
export function stripDue(body) {
  return String(body)
    .split(/(\s+)/)
    .filter((tok) => {
      if (tok === "" || /^\s+$/.test(tok)) return true;
      const m = tok.match(/^due:(\d{4}-\d{2}-\d{2})$/);
      return !(m && isValidDate(m[1]));
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function withCtime(body, stamp) {
  const b = stripCtime(body);
  if (!stamp) return b;
  return b ? `${b} ctime:${stamp}` : `ctime:${stamp}`;
}
