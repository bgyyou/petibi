# -*- coding: utf-8 -*-
"""
take_m5_screenshots.py — M5 工单截图采集（安装器 + 登录页设计升级）。

用途：
  - 截取新登录页（含 16 人格像素形象墙 + slogan）：owner 实测反馈"中部留白大、
    无品牌感"问题已通过 persona-wall + slogan 解决；
  - 截取安装器界面（NSIS sidebar 用 installer-header.bmp，164×314 像素品牌插画）；
  - 截图存 docs/tech/screenshots/m5/，供 owner / 评测对照 DESIGN.md §6。

依赖：playwright（与 take_t3_screenshots.py 同源）；python -m http.server。

用法：python scripts/take_m5_screenshots.py
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RENDERER_DIR = REPO_ROOT / "out" / "renderer"
SHOTS_DIR = REPO_ROOT / "docs" / "tech" / "screenshots" / "m5"

HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8766

# 截图目标（输出文件名, URL, 视口宽, 视口高, 等待毫秒）
SHOTS = [
    ("01-setup-login-m5.png", "/setup/index.html", 820, 660, 2500),
    ("02-setup-pick-m5.png",  "/setup/index.html", 820, 720, 2000),
    ("03-panel-chat-m5.png",  "/panel/index.html", 420, 660, 1500),
]


def wait_port_open(host: str, port: int, timeout_s: int = 10) -> bool:
    """等到 host:port 可连接；返回 True 表示已开。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def start_http_server() -> subprocess.Popen:
    """后台启动 python -m http.server 指向 out/renderer。"""
    if not RENDERER_DIR.exists():
        raise RuntimeError(f"out/renderer 不存在：{RENDERER_DIR}（先跑 npm run build:app）")
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(HTTP_PORT), "--bind", HTTP_HOST],
        cwd=str(RENDERER_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_port_open(HTTP_HOST, HTTP_PORT):
        proc.terminate()
        raise RuntimeError("http server 启动超时")
    print(f"[shots] http server @ {HTTP_HOST}:{HTTP_PORT} ← {RENDERER_DIR}")
    return proc


# 注入脚本：mock window.petApi.getSpriteDataUrl → 让登录页能拿到 16 sprite data URL
# 真实使用 base.png（路径相对 setup 入口 → /sprites/<type>/base.png）
INIT_SCRIPT = r"""
window.petApi = {
  getProfile: () => Promise.resolve({ token: 'mock-token', profile: null }),
  setProfile: () => Promise.resolve({ ok: true }),
  completeSetup: () => {},
  completeSetupForExistingUser: () => {},
  enterGuest: () => {},
  cancelSetup: () => {},
  spriteUrl: (type, frame) => `sprites/${type.toLowerCase()}/${frame || 'idle_0'}.png`,
  // M5 关键：getSpriteDataUrl 返回 idle_0 base.png 的 data URL
  getSpriteDataUrl: async (type, frame) => {
    const url = `sprites/${type.toLowerCase()}/${frame || 'idle_0'}.png`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise((resolve) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result);
        r.readAsDataURL(blob);
      });
    } catch (err) {
      return null;
    }
  },
  getPortraitDataUrl: () => Promise.resolve(null),
  getServerBaseUrl: () => 'http://127.0.0.1:8787',
  getServerInfo: () => Promise.resolve({ host: '127.0.0.1', port: 8787, baseURL: 'http://127.0.0.1:8787' }),
  drag: () => {}, showMenu: () => {}, notifyState: () => {},
  onSetState: () => {}, onPetHidden: () => {},
  openPanel: () => {}, hidePet: () => {},
  quickActionChat: () => {}, quickActionPanel: () => {}, quickActionHide: () => {},
  openSetup: () => {}, openSetupRetest: () => {},
  notifyRetestComplete: () => {},
  getCurrentMbti: () => Promise.resolve('intj'),
  onSpriteChange: () => {},
  minimizeSetup: () => {}, minimizePanel: () => {},
};
window.panelApi = {
  getInit: () => Promise.resolve({ profile: null, token: null }),
  hidePanel: () => {},
  onPanelShown: () => {}, onPanelSwitchToChat: () => {},
  onPanelExitGuest: () => {},
  onPanelTabRequest: () => {},
  onProfileChanged: () => {},
  setProfile: () => Promise.resolve({ ok: true }),
  readEncyclopedia: () => Promise.resolve(null),
  readEncyclopediaIndex: () => Promise.resolve({ items: [] }),
  setGuestFlag: () => Promise.resolve({ ok: true }),
  getGuestFlag: () => Promise.resolve({ isGuest: false }),
  logout: () => {},
  notifyAuthExpired: () => {},
};
"""


def take_shots() -> None:
    """主流程：依次截图各页面。"""
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    from playwright.sync_api import sync_playwright

    proc = start_http_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for filename, url, w, h, wait_ms in SHOTS:
                ctx = browser.new_context(viewport={"width": w, "height": h})
                ctx.add_init_script(INIT_SCRIPT)
                page = ctx.new_page()
                full_url = f"http://{HTTP_HOST}:{HTTP_PORT}{url}"
                print(f"[shots] {filename}  ←  {full_url}  ({w}x{h})")
                page.goto(full_url, wait_until="domcontentloaded")
                page.wait_for_timeout(wait_ms)
                # 等字体 @font-face 真正 loaded
                page.evaluate("document.fonts && document.fonts.ready")
                page.wait_for_timeout(800)
                out = SHOTS_DIR / filename
                page.screenshot(path=str(out), full_page=False)
                print(f"[shots]   保存：{out.relative_to(REPO_ROOT)}")
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def take_installer_screenshot() -> None:
    """安装器截图：渲染一个 mock 安装器界面（含 installerSidebar 占位）。

    实际 NSIS 安装器是 .exe，无法在 CI 里直接渲染；这里用 HTML mock：
      - 左侧 164×314 安装器侧栏 = 新 installer-header.png
      - 右侧"安装中"进度条模拟
    把 build/installer/installer-header.png 嵌入 HTML。
    """
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    out_png = REPO_ROOT / "build" / "installer" / "installer-header.png"
    if not out_png.exists():
        print(f"[installer] 跳过：{out_png} 不存在")
        return

    # 用 Playwright 直接渲染 HTML（不需要 Electron）
    from playwright.sync_api import sync_playwright

    # 复制 installer-header.png 到 shots 目录（便于直接附报告）
    target = SHOTS_DIR / "installer-header.png"
    shutil.copy2(out_png, target)

    # 写一个 mock 安装器 HTML：左侧 sidebar + 右侧安装步骤
    mock_html = SHOTS_DIR / "_installer_mock.html"
    # data URL 嵌入图（避免 http server 路径问题）
    import base64
    img_b64 = base64.b64encode(out_png.read_bytes()).decode("ascii")
    img_data_url = f"data:image/png;base64,{img_b64}"
    mock_html.write_text(f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Petibi 安装器（M5 mock）</title>
<style>
  html, body {{
    margin: 0; padding: 0; height: 100%;
    background: #FEF9EF;
    font-family: 'Microsoft YaHei', sans-serif;
    color: #2B2320;
  }}
  .installer-window {{
    display: flex; flex-direction: row;
    width: 540px; height: 420px;
    border: 2px solid #2B2320;
    box-shadow: 4px 4px 0 #2B2320;
  }}
  .installer-sidebar {{
    width: 164px; height: 100%;
    background-image: url('{img_data_url}');
    background-size: cover; background-repeat: no-repeat;
    background-position: top left;
    border-right: 2px solid #2B2320;
    flex: 0 0 auto;
  }}
  .installer-main {{
    flex: 1 1 auto;
    padding: 28px 32px;
    display: flex; flex-direction: column;
    box-sizing: border-box;
    background: #FEF9EF;
  }}
  .installer-title {{
    font-size: 22px; font-weight: 700;
    margin: 0 0 8px 0; color: #2B2320;
    letter-spacing: 1px;
  }}
  .installer-sub {{
    font-size: 13px; color: #8B8680;
    margin-bottom: 28px;
  }}
  .installer-step-row {{
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 14px;
  }}
  .installer-step-bullet {{
    width: 20px; height: 20px;
    border: 2px solid #2B2320;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700;
    background: #FFFFFF;
  }}
  .installer-step-bullet.done {{ background: #3E8F6E; color: #FFFFFF; }}
  .installer-step-bullet.current {{ background: #785D87; color: #FFFFFF; }}
  .installer-step-label {{
    font-size: 14px; color: #2B2320;
  }}
  .installer-progress {{
    margin-top: 24px;
    width: 100%; height: 14px;
    border: 2px solid #2B2320;
    background: #FFFFFF;
    box-shadow: 3px 3px 0 #2B2320;
    position: relative; overflow: hidden;
  }}
  .installer-progress-bar {{
    width: 60%; height: 100%;
    background: #785D87;
  }}
  .installer-progress-text {{
    margin-top: 12px; font-size: 13px; color: #8B8680;
    display: flex; justify-content: space-between;
  }}
  .installer-buttons {{
    margin-top: auto;
    display: flex; justify-content: flex-end; gap: 12px;
  }}
  .installer-btn {{
    padding: 8px 22px;
    border: 2px solid #2B2320;
    background: #FFFFFF;
    font-size: 13px; font-weight: 600;
    box-shadow: 3px 3px 0 #2B2320;
    color: #2B2320;
  }}
  .installer-btn.primary {{
    background: #785D87; color: #FFFFFF;
  }}
  .installer-caption {{
    margin: 8px 0 16px 0;
    font-size: 11px; color: #8B8680;
    font-family: monospace;
    letter-spacing: 0.5px;
  }}
</style>
</head>
<body>
  <div class="installer-window">
    <div class="installer-sidebar" aria-label="Petibi 品牌插画"></div>
    <div class="installer-main">
      <h1 class="installer-title">正在安装 Petibi</h1>
      <p class="installer-sub">请稍候，正在解压安装文件到本地</p>
      <div class="installer-caption">NSIS 一键安装（installerSidebar 164×314）</div>
      <div class="installer-step-row">
        <div class="installer-step-bullet done">✓</div>
        <div class="installer-step-label">检查磁盘空间</div>
      </div>
      <div class="installer-step-row">
        <div class="installer-step-bullet done">✓</div>
        <div class="installer-step-label">解压资源</div>
      </div>
      <div class="installer-step-row">
        <div class="installer-step-bullet current">3</div>
        <div class="installer-step-label">写入快捷方式</div>
      </div>
      <div class="installer-progress">
        <div class="installer-progress-bar"></div>
      </div>
      <div class="installer-progress-text">
        <span>正在安装...</span>
        <span>60%</span>
      </div>
      <div class="installer-buttons">
        <div class="installer-btn">取消</div>
        <div class="installer-btn primary">下一步</div>
      </div>
    </div>
  </div>
</body>
</html>
""", encoding="utf-8")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 560, "height": 440})
        page = ctx.new_page()
        page.goto(f"file:///{str(mock_html).replace(chr(92), '/')}")
        page.wait_for_timeout(500)
        out = SHOTS_DIR / "04-installer-mock.png"
        page.screenshot(path=str(out), full_page=False)
        print(f"[shots]   保存：{out.relative_to(REPO_ROOT)}")
        ctx.close()
        browser.close()


def main() -> int:
    if not shutil.which("python"):
        print("未检测到 python", file=sys.stderr)
        return 1
    try:
        take_shots()
    except Exception as err:
        print(f"[shots] 失败：{err}", file=sys.stderr)
        return 1
    try:
        take_installer_screenshot()
    except Exception as err:
        print(f"[installer] 失败：{err}", file=sys.stderr)
    print(f"[shots] 完成，目录：{SHOTS_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())