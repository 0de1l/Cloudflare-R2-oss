import { createApp } from "vue";
import axios from "axios";
import App from "../assets/App.vue";
import "../assets/main.css";

// Keep the legacy Axios global available to the Vue component.
window.axios = axios;

createApp(App).mount("#app");

app.mount("#app");
