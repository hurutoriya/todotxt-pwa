"""PWA更新フロー実機テスト:
1. 初回インストール時は自動リロードしない
2. sw.js変更→update()で新SWがactivate→通知→自動リロード→内容復元
3. リロード後に更新ループしない

注意: テスト中に sw.js を一時書き換えするが、finally で必ず元に戻す。
"""
import os
import re
import shutil
import sys
import tempfile
import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(BASE, "sw.js")
URL = os.environ.get("E2E_URL", "http://127.0.0.1:8000/")
CHROMEDRIVER = os.environ.get("CHROMEDRIVER_PATH")  # 未設定時は Selenium Manager が自動取得
fails = []

def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name, extra)
    if not cond:
        fails.append(name)

def nav_type(d):
    return d.execute_script("return performance.getEntriesByType('navigation')[0].type")

def stable_for(d, secs):
    d.execute_script("window.__t0 = Date.now()")
    time.sleep(secs)
    return d.execute_script("return Date.now() - window.__t0") >= secs * 1000 - 500

orig = open(SW).read()
m = re.search(r"todotxt-pwa-v(\d+)", orig)
assert m, "CACHE version not found in sw.js"
test_ver = f"todotxt-pwa-v{m.group(1)}-test"
bak = tempfile.NamedTemporaryFile(delete=False, suffix=".js")
bak.close()
shutil.copy(SW, bak.name)

opts = webdriver.ChromeOptions()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-gpu")
driver = webdriver.Chrome(
    service=Service(CHROMEDRIVER) if CHROMEDRIVER else Service(), options=opts)
wait = WebDriverWait(driver, 10)
try:
    driver.get(URL)
    wait.until(EC.presence_of_element_located((By.ID, "btn-sample")))
    # 1. 初回は自動リロードしない
    check("no reload on first install", nav_type(driver) == "navigate" and stable_for(driver, 4))

    # コンテンツを用意
    driver.find_element(By.ID, "btn-sample").click()
    wait.until(EC.visibility_of_element_located((By.ID, "main")))
    n0 = len(driver.find_elements(By.CSS_SELECTOR, "#task-list .task"))

    # 2. サーバー側変更を模擬 (CACHE名変更)
    open(SW, "w").write(orig.replace(m.group(0), test_ver))
    driver.execute_script("navigator.serviceWorker.getRegistration().then(r => r.update())")
    WebDriverWait(driver, 25).until(lambda d: nav_type(d) == "reload")
    check("auto reload on server change", True)
    wait.until(EC.visibility_of_element_located((By.ID, "main")))
    n1 = len(driver.find_elements(By.CSS_SELECTOR, "#task-list .task"))
    check("content restored after update", n1 == n0, f"n0={n0} n1={n1}")
    check("welcome skipped after update",
          not driver.find_element(By.ID, "welcome").is_displayed())

    # 3. 更新ループしない
    check("no reload loop", stable_for(driver, 4))
finally:
    shutil.copy(bak.name, SW)  # 必ず元に戻す
    print("sw.js restored:", test_ver not in open(SW).read())
    driver.quit()

print("E2E UPDATE ALL PASS" if not fails else f"E2E UPDATE {len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
