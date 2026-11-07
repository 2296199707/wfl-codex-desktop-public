import express from "express";
import { inspectWebSshHostKey } from "./web-ssh.mjs";

export function createWebSshRouters({
  service, requireAdmin, assertOperation, mutate, persistentServers,
  retryAfter = () => 0, recordFailure = () => {}, clearFailures = () => {},
}) {
  const router = express.Router();
  const accessRouter = express.Router();
  const handle = (operation) => (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    void operation(request, response).catch((error) => {
      if (response.destroyed || request.aborted) return;
      if (response.headersSent) { response.destroy(); return; }
      next(error.statusCode ? error
        : Object.assign(new Error("网页 SSH 操作失败，请检查服务器配置或稍后重试"), { statusCode: 503 }));
    }).finally(() => {
      for (const field of ["password", "privateKey", "passphrase", "accessKey", "resumeToken"]) {
        if (request.body && typeof request.body === "object") request.body[field] = "";
      }
    });
  };
  const available = () => {
    if (!service) throw Object.assign(new Error("备用窗口不提供网页 SSH 工具"), { statusCode: 404 });
  };
  router.use((request, _response, next) => {
    try { available(); requireAdmin(request); next(); } catch (error) { next(error); }
  });
  router.get("/status", handle(async (request, response) => {
    const [snapshot, persistent] = await Promise.all([
      service.snapshot(request.user.id), persistentServers(request),
    ]);
    response.json({ ...snapshot, persistent, sharePath: "/ssh-access.html" });
  }));
  router.post("/probe", handle(async (request, response) => {
    assertOperation(request, "web-ssh-probe");
    response.json(await inspectWebSshHostKey(request.body || {}));
  }));
  router.post("/targets", handle(async (request, response) => {
    assertOperation(request, "web-ssh-save");
    const target = await mutate(() => service.saveTarget(request.user.id, request.body || {}));
    response.status(201).json({ target });
  }));
  router.delete("/targets/:id", handle(async (request, response) => {
    assertOperation(request, "web-ssh-delete");
    await mutate(() => service.deleteTarget(request.user.id, request.params.id));
    response.json({ deleted: true });
  }));
  router.post("/grants", handle(async (request, response) => {
    assertOperation(request, "web-ssh-grant");
    response.status(201).json(await mutate(() => service.createGrant(request.user.id, request.body || {})));
  }));
  router.get("/grants/:id/link", handle(async (request, response) => {
    response.json(await service.readDirectLink(request.user.id, request.params.id));
  }));
  router.delete("/grants/:id", handle(async (request, response) => {
    assertOperation(request, "web-ssh-revoke");
    await mutate(() => service.revokeGrant(request.user.id, request.params.id));
    response.json({ revoked: true });
  }));
  router.post("/sessions", handle(async (request, response) => {
    assertOperation(request, "web-ssh-connect");
    response.json(await service.issueOwnerTicket(request.user.id, request.body?.reference, request.authSession));
  }));
  accessRouter.post("/sessions", handle(async (request, response) => {
    available();
    assertOperation(request, "web-ssh-access");
    const retry = retryAfter(request);
    if (retry > 0) {
      response.setHeader("Retry-After", String(retry));
      response.status(429).json({ error: "访问密钥尝试过多，请稍后再试" });
      return;
    }
    try {
      const result = await service.issueAccessTicket(request.body?.accessKey);
      clearFailures(request);
      response.json(result);
    } catch (error) {
      if (error.statusCode === 403) recordFailure(request);
      throw error;
    }
  }));
  accessRouter.post("/links/sessions", handle(async (request, response) => {
    available();
    assertOperation(request, "web-ssh-access");
    response.json(await service.issueAccessTicket(request.body?.accessKey, { mode: "link" }));
  }));
  accessRouter.post("/sessions/disconnect", handle(async (request, response) => {
    available();
    assertOperation(request, "web-ssh-disconnect");
    await service.disconnectResume(request.body?.resumeToken);
    response.json({ disconnected: true });
  }));
  const transfer = (operation) => handle(async (request, response) => {
    available();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => { if (!response.writableFinished) abort(); };
    request.once("aborted", abort);
    response.once("close", closed);
    if (request.aborted || response.destroyed) abort();
    try {
      await operation(request, response, { signal: controller.signal });
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", closed);
    }
  });
  const files = (operation) => transfer(async (request, response, options) => {
    assertOperation(request, "web-ssh-files");
    await service.withFiles(request.get("x-wfl-ssh-session"), (remote) => operation(remote, request, response), options);
  });
  accessRouter.post("/files/list", files(async (remote, request, response) => {
    response.json(await remote.list(request.body?.path ?? "."));
  }));
  accessRouter.put("/files", files(async (remote, request, response) => {
    if (!request.is("application/octet-stream")) {
      throw Object.assign(new Error("上传需要原始文件数据"), { statusCode: 415 });
    }
    response.json(await remote.upload(request.query.path, request, { overwrite: request.query.overwrite === "true" }));
  }));
  accessRouter.post("/files/downloads", handle(async (request, response) => {
    available();
    assertOperation(request, "web-ssh-files");
    response.json(await service.issueDownload(request.get("x-wfl-ssh-session"), request.body?.path));
  }));
  accessRouter.get("/files/downloads/:ticket", transfer(async (request, response, options) => {
    await service.useDownload(request.params.ticket, (remote, remotePath) => remote.download(remotePath, response, ({ name, size }) => {
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(size));
      response.setHeader("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Accel-Buffering", "no");
      response.setHeader("Referrer-Policy", "no-referrer");
    }), options);
  }));
  return { router, accessRouter };
}
