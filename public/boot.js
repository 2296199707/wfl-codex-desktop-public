(() => {
  const script = document.currentScript;
  const version = script?.dataset.version || "latest";
  const assetVersion = script?.dataset.assetVersion || version;
  const connectionText = document.getElementById("connectionText");
  let attempt = 0;
  let applicationLoaded = false;
  let runtimeFailed = false;

  const recoveryBar = document.createElement("aside");
  recoveryBar.id = "bootRecoveryBar";
  recoveryBar.hidden = true;
  recoveryBar.setAttribute("role", "alert");
  recoveryBar.innerHTML = `
    <span id="bootRecoveryMessage"></span>
    <span class="boot-recovery-actions">
      <button type="button" id="bootRecoveryReload">刷新</button>
      <a href="/rescue/" target="_blank" rel="noopener">备用窗口</a>
    </span>
  `;
  const recoveryStyle = document.createElement("style");
  recoveryStyle.textContent = `
    #bootRecoveryBar {
      position: fixed;
      inset: 8px 8px auto;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 44px;
      padding: 8px 10px 8px 14px;
      border: 1px solid #c2410c;
      border-radius: 6px;
      background: #fff7ed;
      color: #7c2d12;
      box-shadow: 0 8px 28px rgb(67 20 7 / 20%);
      font: 600 13px/1.4 sans-serif;
    }
    #bootRecoveryBar[hidden] { display: none; }
    #bootRecoveryBar .boot-recovery-actions { display: flex; flex: none; gap: 6px; }
    #bootRecoveryBar button,
    #bootRecoveryBar a {
      min-height: 30px;
      padding: 5px 9px;
      border: 1px solid #9a3412;
      border-radius: 4px;
      background: #fff;
      color: #7c2d12;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    @media (max-width: 560px) {
      #bootRecoveryBar { align-items: flex-start; }
      #bootRecoveryBar .boot-recovery-actions { flex-direction: column; }
    }
  `;
  document.head.append(recoveryStyle);
  document.body.append(recoveryBar);

  const showRecovery = (kind) => {
    runtimeFailed = kind === "运行异常" || runtimeFailed;
    const message = document.getElementById("bootRecoveryMessage");
    if (message) message.textContent = `${kind} · WFL Codex Web Workspace v${version}`;
    recoveryBar.hidden = false;
  };

  document.getElementById("bootRecoveryReload")?.addEventListener("click", () => location.reload());
  // A late request cancellation, extension fault, or rejected optional task
  // must not turn a healthy, connected application into a permanent fatal
  // banner. Module-evaluation faults are handled by import() below; errors
  // are considered fatal here only while the application is still loading.
  window.addEventListener("error", () => {
    if (!applicationLoaded) showRecovery("运行异常");
  });
  window.addEventListener("unhandledrejection", () => {
    if (!applicationLoaded) showRecovery("运行异常");
  });
  window.addEventListener("codex-desktop:fatal-error", () => {
    runtimeFailed = true;
    showRecovery("运行异常");
  });

  const loadApplication = async () => {
    const url = new URL("/app.js?v=0.44.64", location.origin);
    url.searchParams.set("v", assetVersion);
    if (attempt) url.searchParams.set("recovery", `${Date.now()}-${attempt}`);
    try {
      await import(url.href);
      applicationLoaded = true;
      if (!runtimeFailed) recoveryBar.hidden = true;
    } catch (error) {
      console.error("Unable to start WFL Codex Web Workspace:", error);
      attempt += 1;
      if (connectionText) connectionText.textContent = "正在恢复连接";
      showRecovery("主界面启动失败");
      setTimeout(loadApplication, Math.min(1000 * attempt, 5000));
    }
  };

  loadApplication();
})();
