import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource = readFileSync(new URL("../assets/App.vue", import.meta.url), "utf8");
const template = appSource.match(/<template>([\s\S]*?)<\/template>/)[1];
const source = appSource
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/import[\s\S]*?;/g, "")
  .replace("export default", "globalThis.options =");

function mount(url, fetch, overrides = {}) {
  const listeners = {};
  const window = {
    location: new URL(url),
    alert() {},
    history: {
      replaceState(_state, _title, next) { window.location = new URL(next); },
      pushState(_state, _title, next) { window.location = new URL(next); },
    },
    addEventListener(name, listener) { listeners[name] = listener; },
  };
  const scope = { window, URL, fetch, setTimeout() {}, SIZE_LIMIT: 100000000, document: {}, Dialog: {}, Menu: {}, MimeIcon: {}, UploadPopup: {}, ...overrides };
  vm.runInNewContext(source, scope);
  const app = scope.options.data();
  for (const [name, method] of Object.entries(scope.options.methods)) app[name] = method.bind(app);
  for (const [name, getter] of Object.entries(scope.options.computed)) Object.defineProperty(app, name, { get: getter.bind(app) });
  return { app, window, listeners, options: scope.options };
}

const json = (value) => new Response(JSON.stringify(value));
const guest = { authenticated: false, home: "public/", publicRoot: "public/" };
const listing = (key) => ({ value: [{ key, size: 1 }], folders: [] });
const settle = () => new Promise(setImmediate);

test("public notice keeps upload status and rules without the removed privacy and management copy", () => {
  assert.match(template, /所有人均可上传与下载/);
  assert.match(template, /公开浏览与下载；上传暂未开放/);
  assert.match(template, /上传至 public\/ 根目录，单文件上限/);
  assert.match(template, /同名不覆盖/);
  assert.match(template, /上传文件/);
  assert.match(template, /placeholder="搜索文件和文件夹"/);
  assert.match(template, /aria-label="搜索文件和文件夹"/);
  assert.doesNotMatch(template, /上传后立即公开，请勿上传私密文件/);
  assert.doesNotMatch(template, /删除、移动等管理操作仅限管理员/);
});

test("public subdirectory links survive session initialization and keep the directory slash", async () => {
  const requests = [];
  const { app } = mount("https://drive.test/?p=public%2Fnested", async (url) => {
    requests.push(url);
    return json(url === "/api/auth/session" ? guest : listing("public/nested/readme.txt"));
  });
  await app.checkSession();
  await settle();
  assert.equal(app.cwd, "public/nested/");
  assert.deepEqual(requests, ["/api/auth/session", "/api/children/public/nested/"]);
});

test("limited accounts use the session home when opening the site without a path", async () => {
  const { app } = mount("https://drive.test/", async (url) => json(url === "/api/auth/session"
    ? { ...guest, authenticated: true, home: "docs/" } : listing("docs/readme.txt")));
  await app.checkSession();
  assert.equal(app.cwd, "docs/");
});

test("guest history navigation never leaves public and normalizes directory paths", async () => {
  const { app, options, window, listeners } = mount("https://drive.test/", async (url) =>
    json(url === "/api/auth/session" ? guest : listing("public/readme.txt")));
  options.created.call(app);
  await settle();
  window.location = new URL("https://drive.test/?p=private/");
  listeners.popstate();
  assert.equal(app.cwd, "public/");
  assert.equal(window.location.searchParams.get("p"), "public/");
  window.location = new URL("https://drive.test/?p=public/nested");
  listeners.popstate();
  assert.equal(app.cwd, "public/nested/");
});

test("late private listings cannot overwrite the public list after logout", async () => {
  let resolvePrivate;
  const { app } = mount("https://drive.test/?p=private/", (url) => {
    if (url.startsWith("/api/children/private")) return new Promise((resolve) => { resolvePrivate = resolve; });
    return Promise.resolve(json(url === "/api/auth/logout" ? {} : listing("public/readme.txt")));
  });
  app.authenticated = true;
  app.focusedItem = { key: "private/secret.txt" };
  app.clipboard = "private/secret.txt";
  app.showContextMenu = true;
  app.fetchFiles();
  await app.logout();
  await settle();
  resolvePrivate(json(listing("private/secret.txt")));
  await settle();
  assert.equal(app.files[0].key, "public/readme.txt");
  assert.equal(app.focusedItem, "");
  assert.equal(app.clipboard, null);
  assert.equal(app.showContextMenu, false);
});

test("latest refresh wins even when requests target the same directory", async () => {
  const pending = [];
  const { app } = mount("https://drive.test/?p=public/", () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  app.fetchFiles();
  app.fetchFiles();
  pending[1].resolve(json(listing("public/new.txt")));
  await settle();
  pending[0].reject(new Error("Old request failed"));
  await settle();
  assert.equal(app.files[0].key, "public/new.txt");
  assert.equal(app.loadError, false);
});

test("login requires a confirmed authenticated session and handles network failures", async () => {
  const { app } = mount("https://drive.test/", async () => json(guest));
  app.showLogin = true;
  await app.login();
  assert.equal(app.authenticated, false);
  assert.equal(app.showLogin, true);
  assert.equal(app.loginError, true);
  const failed = mount("https://drive.test/", async () => { throw new Error("Offline"); });
  await assert.doesNotReject(failed.app.login());
  assert.equal(failed.app.loginError, true);
});

test("retry after session failure checks the session again before loading files", async () => {
  let offline = true;
  const requests = [];
  const { app } = mount("https://drive.test/", async (url) => {
    requests.push(url);
    if (offline) throw new Error("Offline");
    return json(url === "/api/auth/session" ? guest : listing("public/readme.txt"));
  });
  await app.checkSession();
  assert.equal(app.loadError, true);
  offline = false;
  await app.retryLoading();
  await settle();
  assert.deepEqual(requests, ["/api/auth/session", "/api/auth/session", "/api/children/public/"]);
  assert.equal(app.loadError, false);
});

test("raw links encode special characters once and retain path boundaries", () => {
  const { app } = mount("https://drive.test/", () => {});
  assert.equal(app.rawUrl("public/100% #?.txt"), "/raw/public/100%25%20%23%3F.txt");
});

test("failed logout does not falsely claim the server session was cleared", async () => {
  for (const fetch of [async () => new Response(null, { status: 503 }), async () => { throw new Error("Offline"); }]) {
    const { app } = mount("https://drive.test/", fetch);
    app.authenticated = true;
    await assert.doesNotReject(app.logout());
    assert.equal(app.authenticated, true);
  }
});

test("directory shortcuts switch between public and the account home without changing the session", async () => {
  const requests = [];
  const { app, options, window } = mount("https://drive.test/?p=docs/nested/", async (url) => {
    requests.push(url);
    return json(listing(url.includes("public") ? "public/readme.txt" : "docs/readme.txt"));
  });
  app.authenticated = true;
  app.initialized = true;
  app.home = "docs/";
  app.search = "old filter";
  app.showMenu = true;
  app.showContextMenu = true;
  app.showUploadPopup = true;
  app.focusedItem = { key: "docs/nested/old.txt" };
  app.clipboard = "docs/copy.txt";

  app.switchDirectory(app.publicRoot);
  options.watch.cwd.handler.call(app);
  await settle();
  assert.equal(app.cwd, "public/");
  assert.equal(window.location.searchParams.get("p"), "public/");
  assert.equal(app.files[0].key, "public/readme.txt");
  assert.equal(app.search, "");
  assert.equal(app.showMenu, false);
  assert.equal(app.showContextMenu, false);
  assert.equal(app.showUploadPopup, false);
  assert.equal(app.focusedItem, "");
  assert.equal(app.clipboard, "docs/copy.txt");
  assert.equal(app.authenticated, true);

  app.switchDirectory(app.home);
  options.watch.cwd.handler.call(app);
  await settle();
  assert.equal(app.cwd, "docs/");
  assert.equal(window.location.searchParams.get("p"), "docs/");
  assert.equal(app.files[0].key, "docs/readme.txt");
  assert.equal(app.authenticated, true);
  assert.deepEqual(requests, ["/api/children/public/", "/api/children/docs/"]);
});

test("the home shortcut supports wildcard accounts and accounts whose home is public", async () => {
  for (const home of ["", "public/"]) {
    const { app, options, window } = mount("https://drive.test/?p=public/nested/", async () => json({ value: [], folders: [] }));
    app.authenticated = true;
    app.initialized = true;
    app.home = home;
    app.switchDirectory(app.home);
    options.watch.cwd.handler.call(app);
    await settle();
    assert.equal(app.cwd, home);
    assert.equal(window.location.searchParams.get("p"), home || null);
    assert.equal(app.authenticated, true);
  }
});

test("directory shortcuts ignore guests and avoid redundant reads for the current directory", async () => {
  let reads = 0;
  const { app } = mount("https://drive.test/?p=public/", async () => { reads++; return json({ value: [], folders: [] }); });
  app.switchDirectory("docs/");
  assert.equal(app.cwd, "public/");
  app.authenticated = true;
  app.search = "old filter";
  await app.switchDirectory(app.publicRoot);
  assert.equal(app.search, "");
  assert.equal(reads, 0);
  app.loadError = true;
  await app.switchDirectory(app.publicRoot);
  assert.equal(reads, 1);
  assert.equal(app.loadError, false);
});

test("public capabilities gate upload and management separately across navigation and logout", async () => {
  const { app } = mount("https://drive.test/?p=public/", async (url) => json(url === "/api/auth/session"
    ? { ...guest, authenticated: true, canManagePublic: false, publicUploadEnabled: true, maxPublicUploadBytes: 20 }
    : { value: [], folders: [] }));
  await app.checkSession();
  assert.equal(app.canUpload, true);
  assert.equal(app.canManageDirectory, false);
  assert.equal(app.maxPublicUploadBytes, 20);
  assert.equal(app.visibleMenuItems.some((item) => item.action === "paste"), false);
  app.openContextMenu("public/nested/");
  assert.equal(app.showContextMenu, false);
  app.cwd = "docs/";
  assert.equal(app.canManageDirectory, true);
  assert.equal(app.visibleMenuItems.some((item) => item.action === "paste"), true);
  app.canManagePublic = true;
  await app.logout();
  assert.equal(app.canManagePublic, false);
  assert.equal(app.publicUploadEnabled, true);
  assert.equal(app.canUpload, true);
});

test("all public uploads use the root append route without thumbnails, multipart or framing headers", async () => {
  for (const authenticated of [false, true]) {
    const writes = [];
    const { app } = mount("https://drive.test/?p=public/nested/", async () => json({ value: [], folders: [] }), {
      axios: { put: async (...args) => { writes.push(args); return { status: 201 }; } },
      generateThumbnail() { assert.fail("Public append must skip thumbnails"); },
      multipartUpload() { assert.fail("Public append must skip multipart"); },
      SIZE_LIMIT: 1,
    });
    app.authenticated = authenticated;
    app.canManagePublic = authenticated;
    app.publicUploadEnabled = true;
    const file = { name: "100% #?.png", size: 2, type: "image/png" };
    app.uploadFiles([file]);
    await app.processUploadQueue();
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "/api/upload/public/100%25%20%23%3F.png");
    assert.equal(writes[0][1], file);
    assert.equal(Object.keys(writes[0][2].headers || {}).some((header) => header.toLowerCase() === "content-length"), false);
    assert.equal(app.uploadResults[0].status, "success");
    assert.match(app.uploadResults[0].message, /public\//);
  }
});

test("public file selection rejects oversized files and rechecks size before execution", async () => {
  let writes = 0;
  const { app } = mount("https://drive.test/?p=public/", async () => json({ value: [], folders: [] }), {
    axios: { put: async () => { writes++; } },
  });
  app.publicUploadEnabled = true;
  app.maxPublicUploadBytes = 10;
  app.uploadFiles([{ name: "too-big.txt", size: 11, type: "text/plain" }, { name: "queued.txt", size: 10, type: "text/plain" }]);
  assert.equal(app.uploadQueue.length, 1);
  assert.equal(app.uploadResults[0].status, "error");
  app.maxPublicUploadBytes = 9;
  await app.processUploadQueue();
  assert.equal(writes, 0);
  assert.equal(app.uploadResults[1].status, "error");
});

test("conflicts, backend limits and network errors remain visible without retry or automatic rename", async () => {
  for (const status of [409, 413, 503, 400, undefined]) {
    let writes = 0;
    const { app } = mount("https://drive.test/?p=public/", async () => json({ value: [], folders: [] }), {
      axios: { put: async () => { writes++; throw { response: status ? { status } : undefined }; } },
    });
    app.publicUploadEnabled = true;
    app.uploadFiles([{ name: "readme.txt", size: 2, type: "text/plain" }]);
    await app.processUploadQueue();
    assert.equal(writes, 1);
    assert.equal(app.uploadResults[0].status, "error");
    assert.ok(app.uploadResults[0].message.length > 0);
    if (status === 409) assert.match(app.uploadResults[0].message, /同名/);
  }
});

test("private upload behavior stays available while disabled public upload fails closed", async () => {
  const writes = [];
  const { app } = mount("https://drive.test/?p=public/", async () => json({ value: [], folders: [] }), {
    axios: { put: async (...args) => { writes.push(args); } },
  });
  app.authenticated = true;
  app.uploadFiles([{ name: "no.txt", size: 2, type: "text/plain" }]);
  assert.equal(app.uploadQueue.length, 0);
  app.cwd = "docs/";
  app.uploadFiles([{ name: "yes.txt", size: 2, type: "text/plain" }]);
  await app.processUploadQueue();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "/api/write/items/docs/yes.txt");
});

test("logout cancels queued private uploads and an in-flight thumbnail cannot start a private write", async () => {
  let finishThumbnail;
  let writes = 0;
  const { app } = mount("https://drive.test/?p=docs/", async () => json({ value: [], folders: [] }), {
    axios: { put: async () => { writes++; } },
    generateThumbnail: () => new Promise((resolve) => { finishThumbnail = resolve; }),
    blobDigest: async () => "thumbnail",
  });
  app.authenticated = true;
  app.uploadFiles([{ name: "old.png", size: 2, type: "image/png" }, { name: "queued.txt", size: 2, type: "text/plain" }]);
  const uploading = app.processUploadQueue();
  await app.logout();
  finishThumbnail({});
  await uploading;
  assert.equal(writes, 0);
  assert.equal(app.uploadQueue.length, 0);
  assert.equal(app.uploadResults.length, 0);
  assert.equal(app.uploadProgress, null);
});

test("authentication changes clear private upload history and ignore late progress or completion", async () => {
  for (const transition of ["logout", "login"]) {
    let finishUpload;
    let lateProgress;
    const { app } = mount("https://drive.test/?p=private/", async (url) => json(url === "/api/auth/session"
      ? { ...guest, authenticated: true, home: "another-user/" }
      : { value: [], folders: [] }), {
      axios: { put: (url, _file, options) => {
        if (url.endsWith("completed-private.txt")) return Promise.resolve();
        lateProgress = options.onUploadProgress;
        return new Promise((resolve) => { finishUpload = resolve; });
      } },
    });
    app.authenticated = true;
    app.uploadFiles([{ name: "completed-private.txt", size: 100, type: "text/plain" }]);
    await app.processUploadQueue();
    assert.equal(app.uploadResults[0].status, "success");
    assert.match(app.uploadResults[0].message, /private\//);
    app.uploadFiles([
      { name: "pending-private.txt", size: 100, type: "text/plain" },
      { name: "queued-private.txt", size: 100, type: "text/plain" },
    ]);
    const uploading = app.processUploadQueue();
    lateProgress({ loaded: 25, total: 100 });
    assert.equal(app.uploadProgress, 25);
    await app[transition]();
    assert.equal(app.uploadResults.length, 0);
    assert.equal(app.uploadQueue.length, 0);
    assert.equal(app.uploadProgress, null);
    lateProgress({ loaded: 90, total: 100 });
    assert.equal(app.uploadProgress, null);
    finishUpload();
    await uploading;
    assert.equal(app.uploadResults.length, 0);
    assert.equal(app.uploadProgress, null);
  }
});

test("public mutation helpers reject ordinary users before prompting or issuing writes", async () => {
  const { app } = mount("https://drive.test/?p=public/", async () => json({ value: [], folders: [] }));
  app.authenticated = true;
  app.clipboard = "docs/source.txt";
  await app.createFolder();
  await app.pasteFile();
  await app.renameFile("public/old.txt");
  await app.removeFile("public/old.txt");
  await app.moveFile("public/old.txt");
  await assert.rejects(app.copyPaste("public/old.txt", "docs/copy.txt"), /权限/);
});

test("a denied copy destination stops a private-to-public move before its source can be deleted", async () => {
  let deletes = 0;
  const { app, window } = mount("https://drive.test/?p=docs/", async () => json({ value: [], folders: [] }), {
    axios: { delete: async () => { deletes++; } },
    console: { error() {} },
    alert() {},
  });
  app.authenticated = true;
  app.folders = ["public/"];
  window.prompt = () => "2";
  await app.moveFile("docs/keep.txt");
  assert.equal(deletes, 0);
});

test("login applies server capabilities and concurrent queue starts still send files serially", async () => {
  const writes = [];
  let finishFirst;
  const { app } = mount("https://drive.test/", async (url) => json(url === "/api/auth/session"
    ? { ...guest, authenticated: true, canManagePublic: true, publicUploadEnabled: true, maxPublicUploadBytes: 100 }
    : { value: [], folders: [] }), {
    axios: { put: (url) => {
      writes.push(url);
      return writes.length === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : Promise.resolve();
    } },
  });
  await app.login();
  assert.equal(app.canManagePublic, true);
  assert.equal(app.publicUploadEnabled, true);
  assert.equal(app.maxPublicUploadBytes, 100);
  app.uploadFiles([{ name: "first.txt", size: 2, type: "text/plain" }]);
  const uploading = app.processUploadQueue();
  app.uploadFiles([{ name: "second.txt", size: 2, type: "text/plain" }]);
  await app.processUploadQueue();
  assert.equal(writes.length, 1);
  finishFirst();
  await uploading;
  assert.deepEqual(writes, ["/api/upload/public/first.txt", "/api/upload/public/second.txt"]);
});
