<script setup>
defineProps({
  modelValue: Boolean,
  items: {
    type: Array,
    required: true,
  },
});

const emit = defineEmits(["update:modelValue", "click"]);

function select(item) {
  emit("update:modelValue", false);
  emit("click", item.action || item.text);
}
</script>

<template>
  <div class="menu">
    <Transition name="fade">
      <div
        v-show="modelValue"
        class="menu-modal"
        @click="emit('update:modelValue', false)"
      ></div>
    </Transition>
    <div v-show="modelValue" id="account-actions-menu" class="menu-content">
      <ul>
        <li
          v-for="(item, index) in items"
          :key="index"
          :class="{ 'menu-separator': item.action === 'paste' || item.action === 'logout' }"
        >
          <button class="menu-item" type="button" @click="select(item)">
            <span v-text="item.text"></span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.menu-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.16);
  z-index: 1;
}

.menu-content {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 188px;
  max-width: calc(100vw - 24px);
  max-height: min(70vh, 420px);
  overflow-y: auto;
  padding: 6px;
  background: linear-gradient(180deg, #151b1a, #0d1110);
  color: #e6f1ed;
  border: 1px solid #344440;
  z-index: 2;
  border-radius: 11px;
  box-shadow: 0 14px 34px #000a, inset 0 1px 0 #ffffff0a;
}

.menu-content ul {
  display: grid;
  gap: 2px;
}

.menu-content li.menu-separator {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid #303a37;
}

.menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 40px;
  padding: 0 11px;
  border-radius: 7px;
  background: transparent;
  color: #c3d0cc;
  text-align: left;
  font-size: 14px;
  transition: background-color 150ms ease, color 150ms ease;
}

.menu-item:hover {
  background: #1a2925;
  color: #baf3df;
}

.menu-item:focus-visible {
  outline: 2px solid #91e3cf;
  outline-offset: -2px;
}
</style>
