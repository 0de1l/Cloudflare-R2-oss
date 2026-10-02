<template>
  <div class="main" @dragenter.prevent @dragover.prevent @drop.prevent="onDrop">
    <div v-if="!initialized" class="state-panel">加载中...</div>
    <div v-else-if="showLogin" class="login-panel">
      <form @submit.prevent="login">
        <h1>用户登录</h1>
        <input v-model="loginForm.username" autocomplete="username" placeholder="用户名" required />
        <input v-model="loginForm.password" autocomplete="current-password" type="password" placeholder="密码" required />
        <p v-if="loginError" class="login-error">登录失败，请检查账号、密码或网络后重试</p>
        <button type="submit">登录</button>
        <button type="button" class="secondary-button" @click="showLogin = false">返回公共区</button>
      </form>
    </div>
    <template v-else-if="initialized">
    <progress
      v-if="uploadProgress !== null"
      :value="uploadProgress"
      max="100"
    ></progress>
    <UploadPopup
      v-model="showUploadPopup"
      :can-upload="canUpload"
      :can-create-folder="canManageDirectory"
      :public-upload="inPublicDirectory"
      :max-bytes="maxPublicUploadBytes"
      @upload="onUploadClicked"
      @createFolder="createFolder"
    ></UploadPopup>
    <div class="app-bar">
      <div class="location-label">
        <strong>{{ !authenticated || inPublicDirectory ? "公共区" : "文件库" }}</strong>
        <span>{{ cwd || "全部文件" }}</span>
      </div>
      <nav v-if="authenticated" class="directory-switch" aria-label="目录切换">
        <button
          type="button"
          :aria-current="inPublicDirectory ? 'location' : null"
          @click="switchDirectory(publicRoot)"
        >
          <svg class="directory-switch-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
          </svg>
          <span>公共区</span>
        </button>
        <button
          type="button"
          :aria-current="!inPublicDirectory ? 'location' : null"
          @click="switchDirectory(home)"
        >
          <svg class="directory-switch-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
            <path d="M3.5 10h17" />
          </svg>
          <span>我的目录</span>
        </button>
      </nav>
      <input type="search" v-model="search" aria-label="Search" />
      <button v-if="!authenticated" class="account-action" @click="showLogin = true">用户登录</button>
      <div v-if="authenticated" class="menu-button">
        <button class="circle" @click="showMenu = true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 448 512"
            width="24"
            height="24"
            title="Menu"
            style="display: block; margin: 4px"
          >
            <!--! Font Awesome Pro 6.2.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. -->
            <path
              d="M120 256c0 30.9-25.1 56-56 56s-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56zm160 0c0 30.9-25.1 56-56 56s-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56zm104 56c-30.9 0-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56s-25.1 56-56 56z"
            />
          </svg>
        </button>
          <Menu
            v-model="showMenu"
            :items="visibleMenuItems"
            @click="onMenuClick"
          />
      </div>
    </div>
    <div v-if="inPublicDirectory && canUpload" class="public-upload-bar">
      <button v-if="publicUploadEnabled" class="public-upload-action" @click="showUploadPopup = true">上传文件</button>
    </div>
    <ul v-if="uploadResults.length" class="upload-results" aria-live="polite" aria-label="上传结果">
      <li v-for="(result, index) in uploadResults" :key="index" :class="`upload-result-${result.status}`">
        <span class="upload-result-name">{{ result.name }}</span>
        <span>{{ result.message }}</span>
      </li>
    </ul>
    <ul class="file-list">
      <li v-if="cwd !== '' && (authenticated || cwd !== publicRoot)">
        <div
          tabindex="0"
          class="file-item"
          @click="cwd = cwd.replace(/[^\/]+\/$/, '')"
          @contextmenu.prevent
        >
          <div class="file-icon">
            <img
              class="folder-icon"
              src="https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png"
              width="36"
              height="36"
              alt="Folder"
            />
          </div>
          <span class="file-name">..</span>
        </div>
      </li>
      <li v-for="folder in filteredFolders" :key="folder">
        <div
          tabindex="0"
          class="file-item"
          @click="cwd = folder"
          @contextmenu.prevent="openContextMenu(folder)"
        >
          <div class="file-icon">
            <img
              class="folder-icon"
              src="https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png"
              width="36"
              height="36"
              alt="Folder"
            />
          </div>
          <span
            class="file-name"
            v-text="folder.match(/.*?([^/]*)\/?$/)[1]"
          ></span>
          <div v-if="canManagePath(folder)" style="margin-right: 10px;margin-left: auto;"
            @click.stop="
              showContextMenu = true;
              focusedItem = folder;
            "
            >
              <svg viewBox="0 0 24 24" style="height: 30px; width: 30px;"><path fill="currentColor" d="M10.5,12A1.5,1.5 0 0,1 12,10.5A1.5,1.5 0 0,1 13.5,12A1.5,1.5 0 0,1 12,13.5A1.5,1.5 0 0,1 10.5,12M10.5,16.5A1.5,1.5 0 0,1 12,15A1.5,1.5 0 0,1 13.5,16.5A1.5,1.5 0 0,1 12,18A1.5,1.5 0 0,1 10.5,16.5M10.5,7.5A1.5,1.5 0 0,1 12,6A1.5,1.5 0 0,1 13.5,7.5A1.5,1.5 0 0,1 12,9A1.5,1.5 0 0,1 10.5,7.5M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"></path></svg>
          </div>
        </div>
      </li>
      <li v-for="file in filteredFiles" :key="file.key">
        <div
          @click="preview(rawUrl(file.key))"
          @contextmenu.prevent="openContextMenu(file)"
        >
          <div class="file-item">
            <MimeIcon
              :content-type="file.httpMetadata.contentType"
              :thumbnail="
                file.customMetadata.thumbnail
                  ? authenticated ? `/raw/_$flaredrive$/thumbnails/${file.customMetadata.thumbnail}.png` : null
                  : null
              "
            />
            <div>
              <div class="file-name" v-text="file.key.split('/').pop()"></div>
              <div class="file-attr">
                <span v-text="new Date(file.uploaded).toLocaleString()"></span>
                <span v-text="formatSize(file.size)"></span>
              </div>
            </div>
            <div class="file-actions">
            <a
              v-if="!canManagePath(file.key)"
              class="download-action"
              :href="rawUrl(file.key)"
              :download="file.key.split('/').pop()"
              @click.stop
            >下载</a>
            <div v-else style="margin-right: 10px;margin-left: auto;"
            @click.stop="
              showContextMenu = true;
              focusedItem = file;
            "
            >
              <svg viewBox="0 0 24 24" style="height: 30px; width: 30px;"><path fill="currentColor" d="M10.5,12A1.5,1.5 0 0,1 12,10.5A1.5,1.5 0 0,1 13.5,12A1.5,1.5 0 0,1 12,13.5A1.5,1.5 0 0,1 10.5,12M10.5,16.5A1.5,1.5 0 0,1 12,15A1.5,1.5 0 0,1 13.5,16.5A1.5,1.5 0 0,1 12,18A1.5,1.5 0 0,1 10.5,16.5M10.5,7.5A1.5,1.5 0 0,1 12,6A1.5,1.5 0 0,1 13.5,7.5A1.5,1.5 0 0,1 12,9A1.5,1.5 0 0,1 10.5,7.5M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"></path></svg>
            </div>
            </div>
          </div>
        </div>
      </li>
    </ul>
    <div v-if="loading" style="margin-top: 12px; text-align: center">
      <span>加载中...</span>
    </div>
    <div v-else-if="loadError" class="state-panel">
      <span>无法读取此目录</span>
      <button class="secondary-button" @click="retryLoading">重试</button>
    </div>
    <div
      v-else-if="!filteredFiles.length && !filteredFolders.length"
      style="margin-top: 12px; text-align: center"
    >
      <span>{{ !authenticated && cwd === publicRoot ? "公共区还没有文件" : "没有文件" }}</span>
      <button v-if="canUpload && inPublicDirectory" class="empty-admin-link" @click="showUploadPopup = true">上传第一个公共文件</button>
    </div>
    <Dialog v-model="showContextMenu">
      <div
        v-text="focusedItem.key || focusedItem"
        class="contextmenu-filename"
        @click.stop.prevent
      ></div>
      <ul v-if="typeof focusedItem === 'string' && canManagePath(focusedItem)" class="contextmenu-list">
        <li>
          <button @click="copyLink(`/?p=${encodeURIComponent(focusedItem)}`)">
            <span>复制链接</span>
          </button>
        </li>
        <li>
          <button @click="moveFile(focusedItem + '_$folder$')">
            <span>移动</span>
          </button>
        </li>
        <li>
          <button
            style="color: red"
            @click="removeFile(focusedItem + '_$folder$')"
          >
            <span>删除</span>
          </button>
        </li>
      </ul>
      <ul v-else-if="focusedItem && typeof focusedItem !== 'string'" class="contextmenu-list">
        <li v-if="canManagePath(focusedItem.key)">
          <button @click="renameFile(focusedItem.key)">
            <span>重命名</span>
          </button>
        </li>
        <li>
          <a :href="rawUrl(focusedItem.key)" target="_blank" download>
            <span>下载</span>
          </a>
        </li>
        <li v-if="canManagePath(focusedItem.key)">
          <button @click="clipboard = focusedItem.key">
            <span>复制</span>
          </button>
        </li>
        <li v-if="canManagePath(focusedItem.key)">
          <button @click="moveFile(focusedItem.key)">
            <span>移动</span>
          </button>
        </li>
        <li>
          <button @click="copyLink(rawUrl(focusedItem.key))">
            <span>复制下载链接</span>
          </button>
        </li>
        <li v-if="canManagePath(focusedItem.key)">
          <button style="color: red" @click="removeFile(focusedItem.key)">
            <span>删除</span>
          </button>
        </li>
      </ul>
    </Dialog>
    </template>
  </div>
</template>

<script>
import {
  generateThumbnail,
  blobDigest,
  multipartUpload,
  SIZE_LIMIT,
} from "/assets/main.mjs";
import Dialog from "./Dialog.vue";
import Menu from "./Menu.vue";
import MimeIcon from "./MimeIcon.vue";
import UploadPopup from "./UploadPopup.vue";

export default {
  data: () => ({
    authenticated: false,
    initialized: false,
    showLogin: false,
    publicRoot: "public/",
    home: "public/",
    publicUploadEnabled: false,
    maxPublicUploadBytes: 52428800,
    canManagePublic: false,
    menuItems: [],
    loginError: false,
    loginForm: { username: "", password: "" },
    cwd: new URL(window.location).searchParams.get("p") || "",
    files: [],
    folders: [],
    clipboard: null,
    focusedItem: "",
    loading: false,
    loadError: false,
    sessionError: false,
    lastFetchedPath: null,
    listRequestId: 0,
    order: null,
    search: "",
    showContextMenu: false,
    showMenu: false,
    showUploadPopup: false,
    uploadProgress: null,
    uploadQueue: [],
    uploadResults: [],
    uploadProcessing: false,
    uploadSessionId: 0,
  }),

  computed: {
    inPublicDirectory() {
      return this.cwd.startsWith(this.publicRoot);
    },

    canManageDirectory() {
      return this.canManagePath(this.cwd);
    },

    canUpload() {
      return this.inPublicDirectory ? this.publicUploadEnabled : this.authenticated;
    },

    visibleMenuItems() {
      return this.menuItems.filter((item) =>
        (item.action !== "paste" || this.canManageDirectory) &&
        (item.action !== "upload" || this.canUpload || this.canManageDirectory));
    },

    filteredFiles() {
      let files = this.files;
      if (this.search) {
        files = files.filter((file) =>
          file.key.split("/").pop().includes(this.search)
        );
      }
      return files;
    },

    filteredFolders() {
      let folders = this.folders;
      if (this.search) {
        folders = folders.filter((folder) => folder.includes(this.search));
      }
      return folders;
    },
  },

  methods: {
    async checkSession() {
      this.loadError = false;
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) throw new Error("Session check failed");
        const session = await response.json();
        this.authenticated = session.authenticated;
        this.applyPublicCapabilities(session);
        this.publicRoot = session.publicRoot || "public/";
        this.home = session.home ?? this.publicRoot;
        const requestedPath = new URL(window.location).searchParams.get("p") || "";
        this.cwd = this.directoryPath(requestedPath);
        if (requestedPath !== this.cwd) this.updateLocation();
        this.menuItems = this.authenticated ? this.adminMenuItems() : [];
        this.initialized = true;
        this.sessionError = false;
        await this.fetchFiles();
      } catch {
        this.loadError = true;
        this.sessionError = true;
        this.initialized = true;
      }
    },

    directoryPath(path) {
      const normalized = path ? `${path.replace(/\/+$/, "")}/` : "";
      if (this.authenticated) return normalized || this.home;
      return normalized.startsWith(this.publicRoot) && !normalized.split("/").includes("..")
        ? normalized : this.publicRoot;
    },

    applyPublicCapabilities(session) {
      this.publicUploadEnabled = session.publicUploadEnabled === true;
      this.maxPublicUploadBytes = Number.isSafeInteger(session.maxPublicUploadBytes) &&
        session.maxPublicUploadBytes > 0 && session.maxPublicUploadBytes <= 52428800
        ? session.maxPublicUploadBytes : 52428800;
      this.canManagePublic = this.authenticated && session.canManagePublic === true;
    },

    canManagePath(path) {
      return this.authenticated && (!(path === this.publicRoot.slice(0, -1) || path.startsWith(this.publicRoot)) || this.canManagePublic);
    },

    switchDirectory(path) {
      if (!this.authenticated) return;
      this.search = "";
      this.showMenu = false;
      this.showContextMenu = false;
      this.showUploadPopup = false;
      this.focusedItem = "";
      const target = this.directoryPath(path);
      if (this.cwd === target) {
        if (this.loadError) return this.fetchFiles();
        return;
      }
      this.cwd = target;
    },

    retryLoading() {
      return this.sessionError ? this.checkSession() : this.fetchFiles();
    },

    adminMenuItems() {
      return [
        { text: '\u540d\u79f0A-Z', action: 'name' },
        { text: '\u5927\u5c0f\u2191', action: 'size-asc' },
        { text: '\u5927\u5c0f\u2193', action: 'size-desc' },
        { text: '\u7c98\u8d34', action: 'paste' },
        { text: '\u4e0a\u4f20\u6587\u4ef6', action: 'upload' },
        { text: '\u767b\u51fa', action: 'logout' },
      ];
    },

    updateLocation() {
      const url = new URL(window.location);
      this.cwd
        ? url.searchParams.set("p", this.cwd)
        : url.searchParams.delete("p");
      window.history.replaceState(null, "", url.toString());
    },

    openContextMenu(item) {
      if (typeof item === "string" && !this.canManagePath(item)) return;
      this.focusedItem = item;
      this.showContextMenu = true;
    },
    rawUrl(key) {
      return `/raw/${key.split("/").map(encodeURIComponent).join("/")}`;
    },
    copyLink(link) {
      const url = new URL(link, window.location.origin);
      navigator.clipboard.writeText(url.toString());
    },

    async copyPaste(source, target) {
      if (!this.canManagePath(source) || !this.canManagePath(target)) {
        throw new Error("没有复制源文件或写入目标目录的权限");
      }
      const uploadUrl = `/api/write/items/${target}`;
      await axios.put(uploadUrl, "", {
        headers: { "x-amz-copy-source": encodeURIComponent(source) },
      });
    },

    async createFolder() {
      if (!this.canManageDirectory) return;
      try {
        const folderName = window.prompt("请输入文件夹名称");
        if (!folderName) return;
        this.showUploadPopup = false;
        const uploadUrl = `/api/write/items/${this.cwd}${folderName}/_$folder$`;
        await axios.put(uploadUrl, "");
        this.fetchFiles();
      } catch (error) {
        fetch("/api/write/")
          .then((value) => {
            if (value.redirected) window.location.href = value.url;
          })
          .catch(() => {});
        console.log(`Create folder failed`);
      }
    },

    async fetchFiles() {
      const requestId = ++this.listRequestId;
      this.files = [];
      this.folders = [];
      this.lastFetchedPath = this.cwd;
      this.loading = true;
      this.loadError = false;
      const path = this.cwd.split("/").map(encodeURIComponent).join("/");
      try {
        const response = await fetch(`/api/children/${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Directory could not be loaded");
        const files = await response.json();
        // A directory change or logout can finish before an older read request.
        if (requestId !== this.listRequestId) return;
        this.files = files.value;
        this.files.sort((a, b) => {
          if (this.order === "size-asc") return a.size - b.size;
          if (this.order === "size-desc") return b.size - a.size;
          return a.key.localeCompare(b.key);
        });
        this.folders = files.folders;
      } catch {
        if (requestId === this.listRequestId) this.loadError = true;
      } finally {
        if (requestId === this.listRequestId) {
          this.loading = false;
        }
      }
    },

    formatSize(size) {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (size >= 1024) {
        size /= 1024;
        i++;
      }
      return `${size.toFixed(1)} ${units[i]}`;
    },

    onDrop(ev) {
      if (!this.canUpload) return;
      let files;
      if (ev.dataTransfer.items) {
        files = [...ev.dataTransfer.items]
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile()).filter(Boolean);
      } else files = ev.dataTransfer.files;
      this.uploadFiles(files);
    },

    onMenuClick(action) {
      switch (action) {
        case "logout":
          return this.logout();
        case "login":
          this.showLogin = true;
          return;
        case "name":
          this.order = null;
          break;
        case "size-asc":
          this.order = "size-asc";
          break;
        case "size-desc":
          this.order = "size-desc";
          break;
        case "paste":
          return this.pasteFile();
        case "upload":
          if (this.canUpload || this.canManageDirectory) this.showUploadPopup = true;
          return;
      }
      this.files.sort((a, b) => {
        if (this.order === "size-asc") return a.size - b.size;
        if (this.order === "size-desc") return b.size - a.size;
        return a.key.localeCompare(b.key);
      });
    },
    async login() {
      this.loginError = false;
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.loginForm),
        });
        if (!response.ok) throw new Error("Login failed");
        const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
        if (!sessionResponse.ok) throw new Error("Session check failed");
        const session = await sessionResponse.json();
        if (!session.authenticated) throw new Error("Session was not established");
        this.authenticated = true;
        this.cancelQueuedUploads();
        this.applyPublicCapabilities(session);
        this.sessionError = false;
        this.publicRoot = session.publicRoot || "public/";
        this.home = session.home ?? "";
        this.showLogin = false;
        this.loginForm = { username: "", password: "" };
        this.search = "";
        this.cwd = this.directoryPath(this.home);
        this.updateLocation();
        this.menuItems = this.adminMenuItems();
        await this.fetchFiles();
      } catch {
        this.loginError = true;
      }
    },

    async logout() {
      try {
        const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
        if (!response.ok) throw new Error("Logout failed");
      } catch {
        window.alert("退出登录失败，请检查网络后重试");
        return;
      }
      this.authenticated = false;
      this.canManagePublic = false;
      this.files = [];
      this.folders = [];
      this.showMenu = false;
      this.showUploadPopup = false;
      this.showContextMenu = false;
      this.focusedItem = "";
      this.clipboard = null;
      this.search = "";
      this.cancelQueuedUploads();
      this.home = this.publicRoot;
      this.cwd = this.publicRoot;
      this.menuItems = [];
      this.updateLocation();
      await this.fetchFiles();
    },

    onUploadClicked(fileElement) {
      if (!fileElement.value) return;
      this.uploadFiles(fileElement.files);
      this.showUploadPopup = false;
      fileElement.value = null;
    },

    preview(filePath){
      window.open(filePath);
    },

    async pasteFile() {
      if (!this.canManageDirectory || !this.clipboard || !this.canManagePath(this.clipboard)) return;
      let newName = window.prompt("Rename to:");
      if (newName === null) return;
      if (newName === "") newName = this.clipboard.split("/").pop();
      await this.copyPaste(this.clipboard, `${this.cwd}${newName}`);
      this.fetchFiles();
    },

    async processUploadQueue() {
      if (this.uploadProcessing) return;
      this.uploadProcessing = true;
      try {
        while (this.uploadQueue.length) {
          const task = this.uploadQueue.shift();
          const { basedir, file, publicAppend, result } = task;
          try {
            this.checkUploadTask(task);
            result.status = "uploading";
            result.message = "上传中...";
            const onUploadProgress = ({ loaded, total }) => {
              if (task.sessionId !== this.uploadSessionId) return;
              if (total) this.uploadProgress = (loaded * 100) / total;
            };
            // Public append must never invoke thumbnail or multipart write routes.
            if (publicAppend) {
              await axios.put(`/api/upload/public/${encodeURIComponent(file.name)}`, file, { onUploadProgress });
            } else {
              let thumbnailDigest = null;
              if (file.type.startsWith("image/") || file.type === "video/mp4") {
                try {
                  const thumbnailBlob = await generateThumbnail(file);
                  const digestHex = await blobDigest(thumbnailBlob);
                  this.checkUploadTask(task);
                  await axios.put(`/api/write/items/_$flaredrive$/thumbnails/${digestHex}.png`, thumbnailBlob);
                  thumbnailDigest = digestHex;
                } catch {
                  // A missing thumbnail should not prevent the original upload.
                }
              }
              this.checkUploadTask(task);
              const headers = {};
              if (thumbnailDigest) headers["fd-thumbnail"] = thumbnailDigest;
              if (file.size >= SIZE_LIMIT) {
                await multipartUpload(`${basedir}${file.name}`, file, { headers, onUploadProgress });
              } else {
                await axios.put(`/api/write/items/${basedir}${file.name}`, file, { headers, onUploadProgress });
              }
            }
            result.status = "success";
            result.message = `已上传至 ${basedir || "/"}`;
          } catch (error) {
            result.status = "error";
            result.message = this.uploadErrorMessage(error);
          }
        }
      } finally {
        this.uploadProcessing = false;
        this.uploadProgress = null;
        await this.fetchFiles();
      }
    },

    checkUploadTask(task) {
      if (task.sessionId !== this.uploadSessionId || (!task.publicAppend && !this.authenticated)) {
        throw new Error("登录状态已变化，上传已取消");
      }
      if (task.publicAppend && !this.publicUploadEnabled) throw new Error("公共上传暂未开放");
      if (task.publicAppend && task.file.size > this.maxPublicUploadBytes) {
        throw new Error(`文件超过上限 ${this.formatSize(this.maxPublicUploadBytes)}`);
      }
    },

    uploadErrorMessage(error) {
      switch (error.response?.status) {
        case 409: return "已存在同名文件，请更改文件名后重新选择；原文件未被覆盖";
        case 413: return `文件超过服务器大小上限（当前 ${this.formatSize(this.maxPublicUploadBytes)}）`;
        case 411: return "无法确定文件大小，请重新选择文件上传";
        case 400: return "文件名或上传内容无效，请检查后重新选择";
        case 503: return "公共上传暂不可用，请稍后重试";
        case 401:
        case 403: return "无上传权限或登录已过期，请重新登录";
        default:
          if (error.response) return "服务器上传失败，请稍后重试";
          return !error.isAxiosError && error.message || "上传失败，请检查网络；刷新列表确认文件是否已上传";
      }
    },

    cancelQueuedUploads() {
      this.uploadSessionId++;
      this.uploadQueue = [];
      this.uploadResults = [];
      this.uploadProgress = null;
    },

    async removeFile(key) {
      if (!this.canManagePath(key)) return;
      if (!window.confirm(`确定要删除 ${key} 吗？`)) return;
      await axios.delete(`/api/write/items/${key}`);
      this.fetchFiles();
    },

    async renameFile(key) {
      if (!this.canManagePath(key)) return;
      const newName = window.prompt("重命名为:");
      if (!newName) return;
      await this.copyPaste(key, `${this.cwd}${newName}`);
      await axios.delete(`/api/write/items/${key}`);
      this.fetchFiles();
    },

    async moveFile(key) {
      if (!this.canManagePath(key)) return;
      // 获取当前的目录结构
      const currentPath = this.cwd; // 当前所在目录
      const allFolders = [...this.folders]; // 所有可用目录
      
      // 如果不在根目录，添加返回上级目录选项
      if (currentPath !== '') {
        const parentPath = currentPath.replace(/[^\/]+\/$/, '');
        if (!allFolders.includes(parentPath) && parentPath !== '') {
          allFolders.unshift(parentPath);
        }
      }
      
      // 添加根目录选项
      if (!allFolders.includes('')) {
        allFolders.unshift('');
      }
      
      // 构建选择列表
      const folderOptions = allFolders.map(folder => {
        const displayName = folder === '' ? '根目录' : 
                          folder === currentPath ? '当前目录' :
                          folder.replace(/.*\/(?!$)|\//g, '') + '/';
        return {
          display: displayName,
          value: folder
        };
      });
      
      // 创建选择提示
      const options = folderOptions.map((opt, index) => 
        `${index + 1}. ${opt.display}`
      ).join('\n');
      
      const promptText = `请选择目标目录(输入数字):\n${options}\n`;
      const selection = window.prompt(promptText);
      
      if (!selection) return;
      
      const selectedIndex = parseInt(selection) - 1;
      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= folderOptions.length) {
        alert('无效的选择');
        return;
      }
      
      const targetPath = folderOptions[selectedIndex].value;
      
      // 获取文件名
      const fileName = key.split('/').pop();
      // 如果是文件夹,需要移除_$folder$后缀
      const finalFileName = fileName.endsWith('_$folder$') ? fileName.slice(0, -9) : fileName;
      
      // 修复：正确处理目标路径，避免双斜杠
      const normalizedPath = targetPath === '' ? '' : (targetPath.endsWith('/') ? targetPath : targetPath + '/');
      
      try {
        // 如果是目录（以_$folder$结尾），则需要移动整个目录内容
        if (key.endsWith('_$folder$')) {
          // 获取源目录的基础路径（移除_$folder$后缀）
          const sourceBasePath = key.slice(0, -9);
          // 获取目标目录的基础路径，修复根目录的情况
          const targetBasePath = normalizedPath + finalFileName + '/';
          
          // 递归获取所有子文件和子目录
          const allItems = await this.getAllItems(sourceBasePath);
          
          // 显示进度提示
          const totalItems = allItems.length;
          let processedItems = 0;
          
          // 移动所有项目
          for (const item of allItems) {
            const relativePath = item.key.substring(sourceBasePath.length);
            const newPath = targetBasePath + relativePath;
            
            try {
              // 复制到新位置
              await this.copyPaste(item.key, newPath);
              // 删除原位置
              await axios.delete(`/api/write/items/${item.key}`);
              
              // 更新进度
              processedItems++;
              this.uploadProgress = (processedItems / totalItems) * 100;
            } catch (error) {
              console.error(`移动 ${item.key} 失败:`, error);
            }
          }
          
          // 移动目录标记
          const targetFolderPath = targetBasePath.slice(0, -1) + '_$folder$';
          await this.copyPaste(key, targetFolderPath);
          await axios.delete(`/api/write/items/${key}`);
          
          // 清除进度
          this.uploadProgress = null;
        } else {
          // 单文件移动逻辑，修复根目录的情况
          const targetFilePath = normalizedPath + finalFileName;
          await this.copyPaste(key, targetFilePath);
          await axios.delete(`/api/write/items/${key}`);
        }
        
        // 刷新文件列表
        this.fetchFiles();
      } catch (error) {
        console.error('移动失败:', error);
        alert('移动失败,请检查目标路径是否正确');
      }
    },

    // 新增：递归获取目录下所有文件和子目录
    async getAllItems(prefix) {
      const items = [];
      let marker = null;
      
      do {
        const url = new URL(`/api/children/${prefix}`, window.location.origin);
        if (marker) {
          url.searchParams.set('marker', marker);
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        // 添加文件
        items.push(...data.value);
        
        // 处理子目录
        for (const folder of data.folders) {
          // 添加目录标记
          items.push({
            key: folder + '_$folder$',
            size: 0,
            uploaded: new Date().toISOString(),
          });
          
          // 递归获取子目录内容
          const subItems = await this.getAllItems(folder);
          items.push(...subItems);
        }
        
        marker = data.marker;
      } while (marker);
      
      return items;
    },

    uploadFiles(files) {
      if (!this.canUpload) return;
      if (this.cwd && !this.cwd.endsWith("/")) this.cwd += "/";
      for (const file of Array.from(files)) {
        const result = { name: file.name, status: "queued", message: "等待上传" };
        this.uploadResults.push(result);
        const task = {
          basedir: this.inPublicDirectory ? this.publicRoot : this.cwd,
          publicAppend: this.inPublicDirectory,
          sessionId: this.uploadSessionId,
          file,
          result,
        };
        try {
          this.checkUploadTask(task);
          this.uploadQueue.push(task);
        } catch (error) {
          result.status = "error";
          result.message = this.uploadErrorMessage(error);
        }
      }
      setTimeout(() => this.processUploadQueue());
    },
  },

  watch: {
    cwd: {
      handler() {
        if (!this.initialized || this.cwd === this.lastFetchedPath) return;
        this.fetchFiles();
        const url = new URL(window.location);
        if ((url.searchParams.get("p") || "") !== this.cwd) {
          this.cwd
            ? url.searchParams.set("p", this.cwd)
            : url.searchParams.delete("p");
          window.history.pushState(null, "", url.toString());
        }
        document.title = `${
          this.cwd.replace(/.*\/(?!$)|\//g, "") || "/"
        } - 文件库`;
      },
    },
  },

  created() {
    this.checkSession();
    window.addEventListener("popstate", (ev) => {
      const searchParams = new URL(window.location).searchParams;
      this.cwd = this.directoryPath(searchParams.get("p") || "");
      if (searchParams.get("p") !== this.cwd) this.updateLocation();
    });
  },

  components: {
    Dialog,
    Menu,
    MimeIcon,
    UploadPopup,
  },
};
</script>

<style>
.main {
  height: 100%;
}

.app-bar {
  position: sticky;
  top: 0;
  padding: 8px;
  background-color: #000;
  display: flex;
}

.menu-button {
  display: flex;
  position: relative;
  margin-left: 4px;
}

.menu-button > button {
  transition: background-color 0.2s ease;
}

.menu-button > button:hover {
  background-color: #202020;
}

.menu {
  position: absolute;
  top: 100%;
  right: 0;
}
</style>
