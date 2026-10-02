import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../assets/App.vue", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/import[\s\S]*?;/g, "")
  .replace("export default", "globalThis.options =");

function mount(url, fetch) {
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
  const scope = { window, URL, fetch, document: {}, Dialog: {}, Menu: {}, MimeIcon: {}, UploadPopup: {} };
  vm.runInNewContext(source, scope);
  const app = scope.options.data();
  for (const [name, method] of Object.entries(scope.options.methods)) app[name] = method.bind(app);
  return { app, window, listeners, options: scope.options };
}

const json = (value) => new Response(JSON.stringify(value));
const guest = { authenticated: false, home: "public/", publicRoot: "public/" };
const listing = (key) => ({ value: [{ key, size: 1 }], folders: [] });
const settle = () => new Promise(setImmediate);

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
