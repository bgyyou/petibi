# -*- coding: utf-8 -*-
"""
take_t3_screenshots.py — T3 工单截图采集（T3 工单自验清单第 5 条）。

使用 Playwright + python http.server 把 out/renderer 静态资源挂起来，
访问 setup / panel / 桌宠三个 HTML，按 DESIGN.md 视觉标准渲染后截图，
存 docs/tech/screenshots/t3/，供 owner 目检。

为什么用 python http.server 而不是 vite dev：
  - electron-vite dev 默认端口 5173 但实际会被 Electron 进程占用，且启动时会拉起整个 Electron 主进程
  - 我们只需要静态 HTML + assets + fonts；用 http.server 直接 serve out/renderer 更稳、更快

用法：
  python scripts/take_t3_screenshots.py

依赖：
  playwright（python，chromium 已 install）
  python -m http.server（标准库）
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
SHOTS_DIR = REPO_ROOT / "docs" / "tech" / "screenshots" / "t3"

# http server 地址 / 端口
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8765

# 截图目标（URL 路径）
PAGES = [
    # (输出文件名, 相对 server 根的 URL, 视口宽, 视口高)
    ("01-setup-login.png",   "/setup/index.html",  820, 660),
    ("02-setup-pick.png",    "/setup/index.html",  820, 720),
    ("03-panel-chat.png",    "/panel/index.html",  420, 660),
    ("04-panel-baike.png",   "/panel/index.html",  420, 660),
    ("05-panel-profile.png", "/panel/index.html",  420, 660),
    ("06-pet.png",           "/index.html",        320, 160),
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
    print(f"[shots] 启动 http server @ {HTTP_HOST}:{HTTP_PORT} ← {RENDERER_DIR}")
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
    print("[shots] http server 已就绪")
    return proc


def setup_result_state(page) -> None:
    """当前 setup 的 state 是 React 内部 reducer，没暴露 localStorage 持久化。
    截图需求里要看 result 页（百分比条），这里用 evaluate 注入脚本伪造 state 比较重。
    简化方案：额外构造一个 result.html 截图页（脱离 React）—— 见 _render_result_screenshot.py。
    """
    pass


def take_shots() -> None:
    """主流程：依次截图各页面。"""
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    from playwright.sync_api import sync_playwright

    # 注入到浏览器上下文的预执行脚本：mock window.petApi / window.panelApi
    # 这样组件在浏览器里能正常 bootstrap（不依赖 Electron 主进程 IPC）
    init_script = """
    // window.petApi: setup / 桌宠窗用
    window.petApi = {
      getProfile: () => Promise.resolve({ token: 'mock-token', profile: null }),
      setProfile: () => Promise.resolve({ ok: true }),
      completeSetup: () => {},
      enterGuest: () => {},
      cancelSetup: () => {},
      spriteUrl: (type, frame) => `sprites/${type.toLowerCase()}/${frame || 'idle_0'}.png`,
      getPortraitDataUrl: () => Promise.resolve(null),
      drag: () => {}, showMenu: () => {}, notifyState: () => {},
      onSetState: () => {}, onPetHidden: () => {},
      openPanel: () => {}, hidePet: () => {},
      quickActionChat: () => {}, quickActionPanel: () => {}, quickActionHide: () => {},
      openSetup: () => {},
      minimizeSetup: () => {}, minimizePanel: () => {},
    };
    // window.panelApi: panel 窗用
    window.panelApi = {
      getInit: () => Promise.resolve({ profile: {
        email: 'demo@petibi.app', nickname: '小明', mbti: 'INTJ',
        subtype: 'stable', createdAt: new Date().toISOString(),
      }, token: 'mock-token' }),
      hidePanel: () => {},
      onPanelShown: () => {}, onPanelSwitchToChat: () => {},
      readEncyclopedia: () => Promise.resolve(null),
      readEncyclopediaIndex: () => Promise.resolve({ items: [] }),
      setGuestFlag: () => Promise.resolve({ ok: true }),
      getGuestFlag: () => Promise.resolve({ isGuest: false }),
    };
    """

    proc = start_http_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for filename, url, w, h in PAGES:
                ctx = browser.new_context(viewport={"width": w, "height": h})
                # 在每个 context 创建前 / 后注入 init script
                ctx.add_init_script(init_script)
                page = ctx.new_page()
                full_url = f"http://{HTTP_HOST}:{HTTP_PORT}{url}"
                print(f"[shots] {filename}  ←  {full_url}  ({w}x{h})")
                page.goto(full_url, wait_until="domcontentloaded")
                # 等字体加载完 + 渲染稳定
                page.wait_for_timeout(1500)
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
        print("[shots] http server 已停止")


def main() -> int:
    if not shutil.which("python"):
        print("未检测到 python", file=sys.stderr)
        return 1
    try:
        take_shots()
    except Exception as err:
        print(f"[shots] 失败：{err}", file=sys.stderr)
        return 1
    print(f"[shots] 完成，目录：{SHOTS_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())