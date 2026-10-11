import { createApp } from "vue";
import axios from "axios";
import App from "../assets/App.vue";
import "../assets/main.css";

window.axios = axios;

const app = createApp({
  components: {
    App: defineAsyncComponent(() => Promise.resolve(App)),
  },
  template: "<App />",
});

app.mount("#app");
