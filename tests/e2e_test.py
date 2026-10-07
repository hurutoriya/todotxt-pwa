import datetime, os, re, sys

CHROMEDRIVER = os.environ.get("CHROMEDRIVER_PATH")  # 未設定時は Selenium Manager が自動取得
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

TODAY = datetime.date.today().isoformat()
URL = os.environ.get("E2E_URL", "http://127.0.0.1:8000/")
fails = []

def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name, extra)
    if not cond:
        fails.append(name)

opts = webdriver.ChromeOptions()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-gpu")
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
driver = webdriver.Chrome(
    service=Service(CHROMEDRIVER) if CHROMEDRIVER else Service(), options=opts)
wait = WebDriverWait(driver, 10)
try:
    driver.get(URL)
    wait.until(EC.presence_of_element_located((By.ID, "btn-sample")))

    # 新コードが読み込まれているか（プレースホルダが目印）
    ph = driver.find_element(By.ID, "quick-add").get_attribute("placeholder")
    check("new app.js loaded (placeholder)", "自動付与" in (ph or ""), ph)

    # サンプルで開始（View Transitionの発火も記録する）
    driver.execute_script("window.__vtSeen = []; new MutationObserver(() => window.__vtSeen.push(document.documentElement.dataset.vtDir)).observe(document.documentElement, {attributes: true, attributeFilter: ['data-vt-dir']})")
    driver.find_element(By.ID, "btn-sample").click()
    wait.until(EC.visibility_of_element_located((By.ID, "main")))
    check("view transition forward fired",
          "forward" in driver.execute_script("return window.__vtSeen"))
    # 閉じる→選択画面に戻る（back遷移）→開き直して続行
    driver.find_element(By.ID, "btn-close").click()
    wait.until(EC.visibility_of_element_located((By.ID, "welcome")))
    check("view transition back fired",
          "back" in driver.execute_script("return window.__vtSeen"))
    driver.find_element(By.ID, "btn-sample").click()
    wait.until(EC.visibility_of_element_located((By.ID, "main")))
    n0 = len(driver.find_elements(By.CSS_SELECTOR, "#task-list .task"))
    check("sample tasks shown", n0 > 0, f"n={n0}")

    # クイック追加（日付なし）→ 今日の日付が付与されるか
    driver.find_element(By.ID, "quick-add").send_keys("実機テストタスク +E2E")
    driver.find_element(By.ID, "btn-add").click()
    wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, "#task-list .task")) == n0 + 1)
    bodies = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#task-list .task")]
    check("quick-add autofill date", any(TODAY in b and "実機テストタスク" in b for b in bodies))

    # 優先度付き追加 → (A) TODAY の順になるか
    driver.find_element(By.ID, "quick-add").send_keys("(A) 優先度付きタスク")
    driver.find_element(By.ID, "btn-add").click()
    wait.until(lambda d: any("優先度付きタスク" in e.text for e in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    bodies = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#task-list .task")]
    check("quick-add autofill with priority", any("優先度付きタスク" in b and TODAY in b for b in bodies))

    # 作成日のない既存タスク（Goodwill）を編集 → 作成日が自動FILLされるか
    tasks = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    target = None
    for t in tasks:
        if "Goodwill" in t.text:
            target = t
            break
    check("found dateless sample task", target is not None)
    if target:
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", target)
        target.click()  # 行タップで編集モーダル
        wait.until(EC.visibility_of_element_located((By.ID, "edit-dialog")))
        check("row tap opens modal (Goodwill)",
              driver.find_element(By.ID, "edit-dialog").is_displayed())
        v = driver.find_element(By.ID, "ed-created").get_attribute("value")
        check("edit dialog autofill creation date", v == TODAY, f"value={v!r}")
        driver.find_element(By.ID, "ed-cancel").click()

    # 期日(due)設定 → プレビューと保存に反映されるか
    tasks = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    target = next(t for t in tasks if "実機テストタスク" in t.text)
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", target)
    target.click()  # 行タップで編集モーダル
    wait.until(EC.visibility_of_element_located((By.ID, "edit-dialog")))
    check("row tap opens modal (due edit)",
          driver.find_element(By.ID, "edit-dialog").is_displayed())
    due = driver.find_element(By.ID, "ed-due")
    check("due input exists", due is not None)
    # 日付ピッカー相当の操作（値セット＋inputイベント発火）
    driver.execute_script("const el = document.getElementById('ed-due'); el.value = '2026-10-05'; el.dispatchEvent(new Event('input', {bubbles: true}));")
    preview = driver.find_element(By.ID, "ed-preview").text
    check("due reflected in preview", "due:2026-10-05" in preview, preview)
    driver.find_element(By.ID, "ed-save").click()
    wait.until(EC.invisibility_of_element_located((By.ID, "edit-dialog")))
    bodies = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#task-list .task")]
    check("due saved to list", any("実機テストタスク" in b and "2026-10-05" in b for b in bodies))
    tasks = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    due_task = next(t for t in tasks if "実機テストタスク" in t.text)
    check("due hidden in body, shown in meta",
          "due:" not in due_task.find_element(By.CSS_SELECTOR, ".body").text
          and "2026-10-05" in due_task.find_element(By.CSS_SELECTOR, ".meta").text)

    # URLはクリッカブルに、メールアドレス・2+2は誤検出しない
    driver.find_element(By.ID, "quick-add").send_keys("資料を確認する https://example.com/todo?x=1&y=2")
    driver.find_element(By.ID, "btn-add").click()
    wait.until(lambda d: any("資料を確認する" in e.text for e in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    driver.find_element(By.ID, "quick-add").send_keys("Email soandso@example.com と 2+2 の計算")
    driver.find_element(By.ID, "btn-add").click()
    wait.until(lambda d: any("soandso@example.com" in e.text for e in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    tasks = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    url_task = next(t for t in tasks if "資料を確認する" in t.text)
    links = url_task.find_elements(By.CSS_SELECTOR, ".body a")
    check("url linkified", len(links) == 1
          and links[0].get_attribute("href") == "https://example.com/todo?x=1&y=2"
          and links[0].get_attribute("target") == "_blank", links[0].text if links else "no link")
    mail_task = next(t for t in tasks if "soandso@example.com" in t.text)
    check("email not linkified", len(mail_task.find_elements(By.CSS_SELECTOR, ".body a")) == 0)
    check("2+2 not project-tagged", len(mail_task.find_elements(By.CSS_SELECTOR, ".tag-proj")) == 0)
    check("project highlight kept", len(driver.find_elements(By.CSS_SELECTOR, ".tag-proj")) > 0)
    tasks = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    bank = next(t for t in tasks if "銀行に電話する" in t.text)
    check("tags in meta not body",
          "+家計" not in bank.find_element(By.CSS_SELECTOR, ".body").text
          and "@phone" not in bank.find_element(By.CSS_SELECTOR, ".body").text
          and "+家計" in bank.find_element(By.CSS_SELECTOR, ".meta").text
          and "@phone" in bank.find_element(By.CSS_SELECTOR, ".meta").text)

    # x付きで直接追加した完了タスクにも完了時刻が自動付与される
    driver.find_element(By.ID, "quick-add").send_keys("x 直接追加の完了タスク")
    driver.find_element(By.ID, "btn-add").click()
    wait.until(lambda d: any("直接追加の完了タスク" in e.text for e in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    ts = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    _t = next(t for t in ts if "直接追加の完了タスク" in t.text)
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", _t)
    _t.click()
    wait.until(EC.visibility_of_element_located((By.ID, "edit-dialog")))
    preview = driver.find_element(By.ID, "ed-preview").text
    check("ctime autofilled on completed quick-add",
          preview.startswith("x ") and re.search(r"ctime:\d{4}-\d{2}-\d{2}-\d{2}-\d{2}", preview) is not None, preview)
    driver.find_element(By.ID, "ed-cancel").click()
    wait.until(EC.invisibility_of_element_located((By.ID, "edit-dialog")))

    # 優先度バッジは作成日の左側(メタ行先頭)に表示される
    tasks = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    bank = next(t for t in tasks if "銀行に電話する" in t.text)
    html = bank.get_attribute("innerHTML")
    check("priority left of creation date",
          'class="pri pri-A"' in html and html.index('pri-A') < html.index('作成'))

    # 完了は一覧のチェックのみ。編集画面に完了項目はなく、完了日は自動付与・保持される
    def open_edit_for(text):
        ts = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
        t = next(x for x in ts if text in x.text)
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", t)
        t.click()  # 行タップで編集モーダル
        wait.until(EC.visibility_of_element_located((By.ID, "edit-dialog")))
        check(f"row tap opens modal ({text})",
              driver.find_element(By.ID, "edit-dialog").is_displayed())
    def toggle_list_checkbox(text):
        ts = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
        t = next(x for x in ts if text in x.text)
        cb = t.find_element(By.CSS_SELECTOR, 'input[type="checkbox"]')
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", cb)
        cb.click()
    open_edit_for("優先度付きタスク")
    check("no done checkbox in edit modal", len(driver.find_elements(By.ID, "ed-done")) == 0)
    driver.find_element(By.ID, "ed-cancel").click()
    wait.until(EC.invisibility_of_element_located((By.ID, "edit-dialog")))
    toggle_list_checkbox("優先度付きタスク")
    wait.until(lambda d: any("優先度付きタスク" in x.text and "done" in x.get_attribute("class") for x in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    bodies = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#task-list .task")]
    check("complete autofills completion date", any("優先度付きタスク" in b and f"完了 {TODAY}" in b for b in bodies))
    open_edit_for("優先度付きタスク")
    preview = driver.find_element(By.ID, "ed-preview").text
    check("completion date preserved on re-edit", f"x {TODAY}" in preview, preview)
    check("ctime recorded in preview",
          re.search(r"ctime:\d{4}-\d{2}-\d{2}-\d{2}-\d{2}", preview) is not None, preview)
    driver.find_element(By.ID, "ed-save").click()
    wait.until(EC.invisibility_of_element_located((By.ID, "edit-dialog")))
    # 完了履歴は一覧内に常時表示される(日付グルーピング＋時刻、切替なし)
    wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ".tl-date")) > 0)
    dates = [e.text for e in driver.find_elements(By.CSS_SELECTOR, ".tl-date")]
    check("history groups by today", any(TODAY in t and "今日" in t for t in dates), dates)
    entries = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#task-list .task")]
    check("history entry with time",
          any("優先度付きタスク" in e and re.search(r"\d{2}:\d{2}", e) for e in entries))
    check("no view switch buttons",
          len(driver.find_elements(By.ID, "view-timeline")) == 0
          and len(driver.find_elements(By.ID, "view-list")) == 0)
    # 履歴上で解除 → 履歴から消え、未完了として一覧に存在
    ts = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    t = next(x for x in ts if "優先度付きタスク" in x.text)
    cb = t.find_element(By.CSS_SELECTOR, 'input[type="checkbox"]')
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", cb)
    cb.click()
    wait.until(lambda d: any("優先度付きタスク" in x.text and "done" not in x.get_attribute("class") for x in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    check("task unmarked", True)

    # 一覧に行ボタンはなく、モーダル左下の削除で消せる
    check("no row action buttons",
          len(driver.find_elements(By.CSS_SELECTOR, "#task-list .task-actions")) == 0)
    driver.find_element(By.ID, "quick-add").send_keys("削除テストタスク")
    driver.find_element(By.ID, "btn-add").click()
    wait.until(lambda d: any("削除テストタスク" in e.text for e in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    open_edit_for("削除テストタスク")
    check("delete button in modal", driver.find_element(By.ID, "ed-delete").is_displayed())
    driver.find_element(By.ID, "ed-delete").click()
    WebDriverWait(driver, 5).until(EC.alert_is_present())
    driver.switch_to.alert.accept()
    wait.until(EC.invisibility_of_element_located((By.ID, "edit-dialog")))
    wait.until(lambda d: not any("削除テストタスク" in e.text for e in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    check("deleted via modal", True)

    # チェックボックス操作ではモーダルが開かず完了トグルできる
    ts = driver.find_elements(By.CSS_SELECTOR, "#task-list .task")
    t = next(x for x in ts if "Post signs" in x.text)
    cb = t.find_element(By.CSS_SELECTOR, 'input[type="checkbox"]')
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", cb)
    cb.click()
    wait.until(lambda d: any("Post signs" in x.text and "done" in x.get_attribute("class") for x in d.find_elements(By.CSS_SELECTOR, "#task-list .task")))
    check("checkbox toggles without modal",
          not driver.find_element(By.ID, "edit-dialog").is_displayed())

    # リロードしても前回内容が自動復元されるか（選択画面を挟まない）
    # 復元完了の合図として「タスクあり＋welcome非表示」の両方を待つ
    # （初回ペイント前はView Transitionのコールバックが遅延するため即時判定しない）
    def restored(d):
        try:
            return (len(d.find_elements(By.CSS_SELECTOR, "#task-list .task")) > 0
                    and not d.find_element(By.ID, "welcome").is_displayed())
        except Exception:
            return False
    driver.refresh()
    WebDriverWait(driver, 15).until(restored)
    welcome_shown = driver.find_element(By.ID, "welcome").is_displayed()
    check("welcome skipped on restore", not welcome_shown)
    bodies = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#task-list .task")]
    check("persist across reload", any("実機テストタスク" in b and "2026-10-05" in b for b in bodies))

    # コンソールにSEVEREエラーがないこと（JS実行時エラーの検出）
    severe = [e for e in driver.get_log("browser") if e.get("level") == "SEVERE"]
    check("no console errors", len(severe) == 0, str(severe[:5]))

    driver.save_screenshot("/tmp/opencode/shot.png")
finally:
    driver.quit()

print("TODAY=" + TODAY)
print("E2E ALL PASS" if not fails else f"E2E {len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
